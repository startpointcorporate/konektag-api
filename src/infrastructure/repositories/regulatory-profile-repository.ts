import type { PoolClient } from 'pg';
import type {
  LegalEntity, LegalEntityStatus,
  CounterpartyEntity,
  RegulatedActor,
  RegulatoryProfile, RegulatoryProfileStatus, AuthorizedOperation, Rail,
  B2BSettlementProfile,
  ComplianceCase, ComplianceCaseStatus,
  KLot, KLotStatus,
  ValuationRecord,
  MerchantSale,
  IntercompanyPosition,
} from '../../domain/RegulatoryProfile.ts';
import { ConcurrencyError } from '../../domain/DomainErrors.ts';

function rowToLegalEntity(row: any): LegalEntity {
  return {
    id: row.id, code: row.code, legalName: row.legal_name,
    countryCode: row.country_code, baseCurrency: row.base_currency,
    frappeCompany: row.frappe_company, regulatoryIdentifier: row.regulatory_identifier,
    taxId: row.tax_id, status: row.status,
    approvedBy: row.approved_by, approvedAt: row.approved_at,
    validFrom: row.valid_from, validUntil: row.valid_until,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function rowToCounterparty(row: any): CounterpartyEntity {
  return {
    id: row.id, code: row.code, legalName: row.legal_name,
    entityType: row.entity_type, countryCode: row.country_code,
    licenseIdentifier: row.license_identifier, contractRef: row.contract_ref,
    contractSignedAt: row.contract_signed_at, status: row.status, version: row.version,
  };
}

function rowToRegulatedActor(row: any): RegulatedActor {
  return {
    id: row.id, actorCode: row.actor_code, actorName: row.actor_name,
    actorType: row.actor_type, counterpartyId: row.counterparty_id,
    jurisdiction: row.jurisdiction, licenseRef: row.license_ref,
    licenseValidFrom: row.license_valid_from, licenseValidUntil: row.license_valid_until,
    status: row.status, approvedBy: row.approved_by, approvedAt: row.approved_at,
    version: row.version,
  };
}

function rowToRegulatoryProfile(row: any): RegulatoryProfile {
  return {
    id: row.id, profileCode: row.profile_code, profileName: row.profile_name,
    legalEntityId: row.legal_entity_id,
    countryOfOrigin: row.country_of_origin, countryOfDestination: row.country_of_destination,
    corridorId: row.corridor_id, authorizedOperation: row.authorized_operation,
    fundHolder: row.fund_holder, regulatedActorId: row.regulated_actor_id,
    rail: row.rail, executionMode: row.execution_mode, minKycLevel: row.min_kyc_level,
    maxAmountPerTx: row.max_amount_per_tx ? Number(row.max_amount_per_tx) : null,
    maxAmountDaily: row.max_amount_daily ? Number(row.max_amount_daily) : null,
    maxAmountMonthly: row.max_amount_monthly ? Number(row.max_amount_monthly) : null,
    maxKSendDepth: row.max_k_send_depth ?? 2, nettingAllowed: row.netting_allowed,
    evidenceRequired: row.evidence_required ?? [],
    status: row.status, approvedBy: row.approved_by, approvedAt: row.approved_at,
    validFrom: row.valid_from, validUntil: row.valid_until,
    version: row.version,
  };
}

function rowToComplianceCase(row: any): ComplianceCase {
  return {
    id: row.id, caseRef: row.case_ref, caseType: row.case_type, severity: row.severity,
    subjectPartyId: row.subject_party_id, subjectUserId: row.subject_user_id,
    legalEntityId: row.legal_entity_id, triggeredBy: row.triggered_by,
    triggeredAt: row.triggered_at, status: row.status, resolution: row.resolution,
    resolvedBy: row.resolved_by, resolvedAt: row.resolved_at,
    finalDecision: row.final_decision, version: row.version,
    evidence: row.evidence ?? [], notes: row.notes,
  };
}

function rowToKLot(row: any): KLot {
  return {
    id: row.id, klotRef: row.klot_ref, originEntityId: row.origin_entity_id,
    originCountry: row.origin_country, rail: row.rail, railRef: row.rail_ref,
    issuer: row.issuer, quantityK: row.quantity_k,
    economicCurrency: row.economic_currency, economicValue: Number(row.economic_value),
    regulatoryProfileId: row.regulatory_profile_id, restrictions: row.restrictions ?? {},
    status: row.status, version: row.version,
  };
}

function rowToB2BProfile(row: any): B2BSettlementProfile {
  return {
    id: row.id, profileCode: row.profile_code,
    legalEntityAId: row.legal_entity_a_id, legalEntityBId: row.legal_entity_b_id,
    nettingAllowed: row.netting_allowed, settlementCurrency: row.settlement_currency,
    fxSource: row.fx_source, fxSpreadBps: row.fx_spread_bps ?? 0,
    minSettlementAmount: row.min_settlement_amount ? Number(row.min_settlement_amount) : null,
    settlementFrequency: row.settlement_frequency, requiredApprovals: row.required_approvals ?? [],
    status: row.status, approvedBy: row.approved_by, approvedAt: row.approved_at,
    validFrom: row.valid_from, validUntil: row.valid_until, version: row.version,
  };
}

export class RegulatoryProfileRepository {
  constructor(private client: PoolClient) {}

  // ── Legal Entities ──

  async findLegalEntityByCode(code: string): Promise<LegalEntity | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.legal_entities WHERE code = $1 AND deleted_at IS NULL`,
      [code],
    );
    return rows[0] ? rowToLegalEntity(rows[0]) : null;
  }

  async findLegalEntityById(id: string): Promise<LegalEntity | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.legal_entities WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? rowToLegalEntity(rows[0]) : null;
  }

  async findApprovedLegalEntity(code: string): Promise<LegalEntity | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.legal_entities WHERE code = $1 AND status = 'APPROVED' AND deleted_at IS NULL`,
      [code],
    );
    return rows[0] ? rowToLegalEntity(rows[0]) : null;
  }

  async updateLegalEntityStatus(id: string, status: LegalEntityStatus, version: number): Promise<void> {
    const { rowCount } = await this.client.query(
      `UPDATE konektag.legal_entities SET status = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3 AND deleted_at IS NULL`,
      [status, id, version],
    );
    if (rowCount === 0) throw new ConcurrencyError('LegalEntity', id, version);
  }

  // ── Regulatory Profiles ──

  async findProfileForOperation(
    operation: AuthorizedOperation,
    origin: string,
    destination: string,
  ): Promise<RegulatoryProfile | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.regulatory_profiles
       WHERE authorized_operation = $1
         AND country_of_origin = $2
         AND country_of_destination = $3
         AND status = 'APPROVED'
         AND deleted_at IS NULL
        ORDER BY valid_from DESC, created_at DESC, id DESC LIMIT 1`,
      [operation, origin, destination],
    );
    return rows[0] ? rowToRegulatoryProfile(rows[0]) : null;
  }

  async findProfileByCode(code: string): Promise<RegulatoryProfile | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.regulatory_profiles WHERE profile_code = $1 AND deleted_at IS NULL`,
      [code],
    );
    return rows[0] ? rowToRegulatoryProfile(rows[0]) : null;
  }

  async findProfilesByEntity(legalEntityId: string): Promise<RegulatoryProfile[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.regulatory_profiles WHERE legal_entity_id = $1 AND deleted_at IS NULL`,
      [legalEntityId],
    );
    return rows.map(rowToRegulatoryProfile);
  }

  async updateProfileStatus(id: string, status: RegulatoryProfileStatus, version: number): Promise<void> {
    const { rowCount } = await this.client.query(
      `UPDATE konektag.regulatory_profiles SET status = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3 AND deleted_at IS NULL`,
      [status, id, version],
    );
    if (rowCount === 0) throw new ConcurrencyError('RegulatoryProfile', id, version);
  }

  // ── Regulated Actors ──

  async findApprovedActor(id: string): Promise<RegulatedActor | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.regulated_actors WHERE id = $1 AND status = 'APPROVED' AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? rowToRegulatedActor(rows[0]) : null;
  }

  // ── Compliance Cases ──

  async findOpenCasesForParty(partyId: string): Promise<ComplianceCase[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.compliance_cases
       WHERE subject_party_id = $1
         AND status IN ('OPEN', 'UNDER_REVIEW', 'ESCALATED')
         AND deleted_at IS NULL`,
      [partyId],
    );
    return rows.map(rowToComplianceCase);
  }

  async findOpenCasesForUser(userId: string): Promise<ComplianceCase[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.compliance_cases
       WHERE subject_user_id = $1
         AND status IN ('OPEN', 'UNDER_REVIEW', 'ESCALATED')
         AND deleted_at IS NULL`,
      [userId],
    );
    return rows.map(rowToComplianceCase);
  }

  // ── KLots ──

  async findAvailableKLot(id: string): Promise<KLot | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.klots
       WHERE id = $1 AND status IN ('AVAILABLE', 'PARTIALLY_CONSUMED') AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? rowToKLot(rows[0]) : null;
  }

  async createKLot(data: Omit<KLot, 'id' | 'version' | 'createdAt' | 'updatedAt'>): Promise<KLot> {
    const { rows } = await this.client.query(
      `INSERT INTO konektag.klots (klot_ref, origin_entity_id, origin_country, rail, rail_ref, issuer,
         quantity_k, economic_currency, economic_value, regulatory_profile_id, restrictions, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [data.klotRef, data.originEntityId, data.originCountry, data.rail, data.railRef,
       data.issuer, data.quantityK, data.economicCurrency, data.economicValue,
       data.regulatoryProfileId, JSON.stringify(data.restrictions), data.status],
    );
    return rowToKLot(rows[0]);
  }

  async updateKLotStatus(id: string, status: KLotStatus, version: number): Promise<void> {
    const { rowCount } = await this.client.query(
      `UPDATE konektag.klots SET status = $1, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3 AND deleted_at IS NULL`,
      [status, id, version],
    );
    if (rowCount === 0) throw new ConcurrencyError('KLot', id, version);
  }

  // ── Valuation Records ──

  async createValuation(data: Omit<ValuationRecord, 'id' | 'createdAt'>): Promise<ValuationRecord> {
    const { rows } = await this.client.query(
      `INSERT INTO konektag.valuation_records (klot_id, source_currency, target_currency, rate,
         spread_bps, rate_source, rate_timestamp, fx_risk_holder)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [data.klotId, data.sourceCurrency, data.targetCurrency, data.rate,
       data.spreadBps, data.rateSource, data.rateTimestamp, data.fxRiskHolder],
    );
    return {
      id: rows[0].id, klotId: rows[0].klot_id,
      sourceCurrency: rows[0].source_currency, targetCurrency: rows[0].target_currency,
      rate: Number(rows[0].rate), spreadBps: rows[0].spread_bps,
      rateSource: rows[0].rate_source, rateTimestamp: rows[0].rate_timestamp,
      fxRiskHolder: rows[0].fx_risk_holder,
    };
  }

  // ── B2B Profiles ──

  async findApprovedB2BProfile(entityAId: string, entityBId: string): Promise<B2BSettlementProfile | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.b2b_settlement_profiles
       WHERE ((legal_entity_a_id = $1 AND legal_entity_b_id = $2)
           OR (legal_entity_a_id = $2 AND legal_entity_b_id = $1))
         AND status = 'APPROVED'
         AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
         AND deleted_at IS NULL
       LIMIT 1`,
      [entityAId, entityBId],
    );
    return rows[0] ? rowToB2BProfile(rows[0]) : null;
  }

  // ── Counterparty ──

  async findActiveCounterparty(code: string): Promise<CounterpartyEntity | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.counterparty_entities WHERE code = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [code],
    );
    return rows[0] ? rowToCounterparty(rows[0]) : null;
  }

  // ── Limits check ──

  async getDailySumForUser(userId: string, operation: AuthorizedOperation, date: string): Promise<number> {
    const { rows } = await this.client.query(
      `SELECT COALESCE(SUM(ABS(le.amount)), 0) as total
       FROM konektag.ledger_entries le
       JOIN konektag.financial_transactions ft ON le.transaction_id = ft.id
       WHERE ft.regulatory_profile_id IN (
         SELECT id FROM konektag.regulatory_profiles WHERE authorized_operation = $2
       )
       AND le.client_id = $1
       AND le.created_at::date = $3::date
       AND ft.status = 'completed'`,
      [userId, operation, date],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getMonthlySumForUser(userId: string, operation: AuthorizedOperation, yearMonth: string): Promise<number> {
    const { rows } = await this.client.query(
      `SELECT COALESCE(SUM(ABS(le.amount)), 0) as total
       FROM konektag.ledger_entries le
       JOIN konektag.financial_transactions ft ON le.transaction_id = ft.id
       WHERE ft.regulatory_profile_id IN (
         SELECT id FROM konektag.regulatory_profiles WHERE authorized_operation = $2
       )
       AND le.client_id = $1
       AND to_char(le.created_at, 'YYYY-MM') = $3
       AND ft.status = 'completed'`,
      [userId, operation, yearMonth],
    );
    return Number(rows[0]?.total ?? 0);
  }

  // ── User Regulatory Overrides ──

  async findActiveOverride(userId: string, operation: AuthorizedOperation, corridorId: string): Promise<{
    maxAmountPerTx: number | null;
    maxAmountDaily: number | null;
    maxAmountMonthly: number | null;
  } | null> {
    const { rows } = await this.client.query(
      `SELECT max_amount_per_tx, max_amount_daily, max_amount_monthly
       FROM konektag.user_regulatory_overrides
       WHERE user_id = $1 AND operation = $2 AND corridor_id = $3
         AND is_active = true
         AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
         AND deleted_at IS NULL
       LIMIT 1`,
      [userId, operation, corridorId],
    );
    if (!rows[0]) return null;
    return {
      maxAmountPerTx: rows[0].max_amount_per_tx ? Number(rows[0].max_amount_per_tx) : null,
      maxAmountDaily: rows[0].max_amount_daily ? Number(rows[0].max_amount_daily) : null,
      maxAmountMonthly: rows[0].max_amount_monthly ? Number(rows[0].max_amount_monthly) : null,
    };
  }
}
