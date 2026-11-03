import type {
  EligibilityContext, EligibilityResult,
  LegalEntity, RegulatoryProfile, RegulatedActor,
  KycLevel,
} from '../../domain/RegulatoryProfile.ts';
import type { PoolClient } from 'pg';
import { RegulatoryProfileRepository } from '../../infrastructure/repositories/regulatory-profile-repository.ts';

const KYC_LEVEL_HIERARCHY: Record<KycLevel, number> = {
  none: 0,
  basic: 1,
  standard: 2,
  enhanced: 3,
};

export class FinancialEligibilityEngine {
  private repo: RegulatoryProfileRepository;
  private client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
    this.repo = new RegulatoryProfileRepository(client);
  }

  async evaluate(context: EligibilityContext): Promise<EligibilityResult> {
    const missing: string[] = [];

    // 1. Find applicable regulatory profile
    const profile = await this.repo.findProfileForOperation(
      context.operation,
      context.countryOfOrigin,
      context.countryOfDestination,
    );

    if (!profile) {
      return {
        decision: 'BLOCKED_NOT_CONFIGURED',
        reason: `Aucun profil reglementaire approuve pour ${context.operation} ${context.countryOfOrigin}->${context.countryOfDestination}`,
        profile: null, legalEntity: null, regulatedActor: null,
        missingRequirements: ['regulatory_profile'],
      };
    }

    // Legal Entity is an accounting attribution for Konektag revenue/fees, not
    // an eligibility prerequisite for P2P, Send K, Link Pay or QR Pay principal.
    const legalEntity: LegalEntity | null = null;

    // 2b. Verify profile is not expired
    const now = new Date().toISOString().slice(0, 10);
    // PostgreSQL DATE values can be parsed as Date objects by the driver.
    const validUntil = profile.validUntil && new Date(profile.validUntil).toISOString().slice(0, 10);
    if (validUntil && validUntil < now) {
      return {
        decision: 'BLOCKED_PROFILE',
        reason: `Profil ${profile.profileCode} expire depuis le ${validUntil}`,
        profile, legalEntity, regulatedActor: null,
        missingRequirements: ['profile_not_expired'],
      };
    }

    // 3. Verify rail matches the profile
    if (context.rail !== profile.rail) {
      return {
        decision: 'BLOCKED_RAIL',
        reason: `Rail ${context.rail} non autorise pour ce profil (attendu: ${profile.rail})`,
        profile, legalEntity, regulatedActor: null,
        missingRequirements: [`rail_${profile.rail}`],
      };
    }

    // 4. Verify regulated actor if profile requires one
    let regulatedActor: RegulatedActor | null = null;
    if (profile.regulatedActorId) {
      regulatedActor = await this.repo.findApprovedActor(profile.regulatedActorId);
      if (!regulatedActor) {
        return {
          decision: 'BLOCKED_RAIL',
          reason: `Acteur reglemente ${profile.regulatedActorId} non approuve`,
          profile, legalEntity, regulatedActor: null,
          missingRequirements: ['approved_regulated_actor'],
        };
      }
    }

    // 5. Check KYC level
    const userKycResult = await this.client.query(
      `SELECT state FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
      [context.userId],
    );

    const kycLevel = this.mapStateToKycLevel(userKycResult.rows[0]?.state ?? 'DRAFT');
    const requiredLevel = profile.minKycLevel;
    if (KYC_LEVEL_HIERARCHY[kycLevel] < KYC_LEVEL_HIERARCHY[requiredLevel]) {
      return {
        decision: 'BLOCKED_KYC',
        reason: `Niveau KYC ${kycLevel} insuffisant (requis: ${requiredLevel})`,
        profile, legalEntity, regulatedActor,
        missingRequirements: [`kyc_level_${requiredLevel}`],
      };
    }

    // 6. Check compliance cases
    const openCases = await this.repo.findOpenCasesForUser(context.userId);
    const blockingCases = openCases.filter(c => c.severity === 'high' || c.severity === 'critical');
    if (blockingCases.length > 0) {
      return {
        decision: 'BLOCKED_COMPLIANCE',
        reason: `${blockingCases.length} dossier(s) conformite bloquant(s): ${blockingCases.map(c => c.caseRef).join(', ')}`,
        profile, legalEntity, regulatedActor,
        missingRequirements: blockingCases.map(c => `resolve_compliance_${c.caseRef}`),
      };
    }

    // 7. Check amount limits — user override takes priority over profile
    const override = await this.repo.findActiveOverride(
      context.userId,
      profile.authorizedOperation,
      profile.corridorId,
    );

    const effectiveMaxPerTx = override?.maxAmountPerTx ?? profile.maxAmountPerTx;
    const effectiveMaxDaily = override?.maxAmountDaily ?? profile.maxAmountDaily;
    const effectiveMaxMonthly = override?.maxAmountMonthly ?? profile.maxAmountMonthly;

    if (effectiveMaxPerTx !== null && context.amount > effectiveMaxPerTx) {
      return {
        decision: 'BLOCKED_LIMIT',
        reason: `Montant ${context.amount} depasse la limite par transaction ${effectiveMaxPerTx} ${override ? '(surcharge utilisateur)' : '(profil)'}`,
        profile, legalEntity, regulatedActor,
        missingRequirements: ['within_tx_limit'],
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const dailySum = await this.repo.getDailySumForUser(context.userId, profile.authorizedOperation, today);
    if (effectiveMaxDaily !== null && (dailySum + context.amount) > effectiveMaxDaily) {
      return {
        decision: 'BLOCKED_LIMIT',
        reason: `Le cumul journalier ${dailySum + context.amount} depasserait la limite ${effectiveMaxDaily} ${override ? '(surcharge utilisateur)' : '(profil)'}`,
        profile, legalEntity, regulatedActor,
        missingRequirements: ['within_daily_limit'],
      };
    }

    const yearMonth = new Date().toISOString().slice(0, 7);
    const monthlySum = await this.repo.getMonthlySumForUser(context.userId, profile.authorizedOperation, yearMonth);
    if (effectiveMaxMonthly !== null && (monthlySum + context.amount) > effectiveMaxMonthly) {
      return {
        decision: 'BLOCKED_LIMIT',
        reason: `Le cumul mensuel ${monthlySum + context.amount} depasserait la limite ${effectiveMaxMonthly} ${override ? '(surcharge utilisateur)' : '(profil)'}`,
        profile, legalEntity, regulatedActor,
        missingRequirements: ['within_monthly_limit'],
      };
    }

    // 8. KLot availability if needed
    if (context.klotId) {
      const klot = await this.repo.findAvailableKLot(context.klotId);
      if (!klot) {
        return {
          decision: 'BLOCKED_PROFILE',
          reason: `KLot ${context.klotId} non disponible`,
          profile, legalEntity, regulatedActor,
          missingRequirements: ['available_klot'],
        };
      }
    }

    // All gates passed
    return {
      decision: 'ALLOWED',
      reason: 'Toutes les conditions reglementaires sont satisfaites',
      profile, legalEntity, regulatedActor,
      missingRequirements: [],
    };
  }

  private mapStateToKycLevel(state: string): KycLevel {
    switch (state) {
      case 'COMPLETED': return 'basic';
      case 'KYC_VERIFIED': return 'standard';
      case 'KYC_ENHANCED': return 'enhanced';
      case 'KYC_SKIPPED':
      default:
        return 'none';
    }
  }

  dispose(): void {
    this.client.release();
  }
}
