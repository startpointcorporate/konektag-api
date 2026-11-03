import pool from '../../infrastructure/database/pool.ts';

export type MerchantActivationGate =
  | 'kyb_documents'
  | 'ubo_verification'
  | 'sanctions_screening'
  | 'contract_signed'
  | 'settlement_account'
  | 'risk_assessment'
  | 'merchant_approved';

export interface ActivationCheckResult {
  canOperate: boolean;
  missingGates: MerchantActivationGate[];
  currentStatus: string;
}

export const merchantActivationService = {

  async checkActivation(merchantProfileId: string): Promise<ActivationCheckResult> {
    const { rows: [profile] } = await pool.query(
      `SELECT status, kyb_status, kyb_contract_ref, kyb_settlement_account, kyb_risk_category,
              kyb_documents_verified, kyb_ubo_verified, kyb_sanctions_screened
       FROM konektag.merchant_profiles
       WHERE id = $1 AND deleted_at IS NULL`,
      [merchantProfileId],
    );

    if (!profile) {
      return { canOperate: false, missingGates: [], currentStatus: 'NOT_FOUND' };
    }

    if (profile.status === 'Suspended') {
      return { canOperate: false, missingGates: ['merchant_approved'], currentStatus: 'SUSPENDED' };
    }
    if (profile.kyb_status === 'MERCHANT_APPROVED') {
      return { canOperate: true, missingGates: [], currentStatus: profile.kyb_status };
    }

    const missing: MerchantActivationGate[] = [];

    if (!profile.kyb_documents_verified) missing.push('kyb_documents');
    if (!profile.kyb_ubo_verified) missing.push('ubo_verification');
    if (!profile.kyb_sanctions_screened) missing.push('sanctions_screening');
    if (!profile.kyb_contract_ref) {
      missing.push('contract_signed');
    }
    if (!profile.kyb_settlement_account) {
      missing.push('settlement_account');
    }
    if (!profile.kyb_risk_category) {
      missing.push('risk_assessment');
    }

    return {
      canOperate: false,
      missingGates: missing.length > 0 ? missing : ['merchant_approved'],
      currentStatus: profile.kyb_status,
    };
  },

  /**
   * Verifie que le marchand est active avant une opération de paiement : QR Pay, Link Pay ou clé API. La visibilité gratuite en est indépendante.
   */
  async requireMerchantApproved(merchantProfileId: string): Promise<{ ok: boolean; error?: string }> {
    const result = await this.checkActivation(merchantProfileId);
    if (!result.canOperate) {
      return {
        ok: false,
        error: `Marchand non active (${result.currentStatus}). Gates manquantes: ${result.missingGates.join(', ')}`,
      };
    }
    return { ok: true };
  },

  async activateMerchant(merchantProfileId: string, approvedBy: string): Promise<void> {
    await pool.query(
      `UPDATE konektag.merchant_profiles
       SET kyb_status = 'MERCHANT_APPROVED', kyb_approved_by = $1, kyb_approved_at = now(),
           kyb_next_review_date = CURRENT_DATE + interval '1 year', updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL`,
      [approvedBy, merchantProfileId],
    );
  },

  /**
   * Verifie que le compte 1100 (Wallet Commercants) n'est PAS credite.
   * Les credits marchands doivent passer par le compte 2000 (Dettes Commercants).
   */
  async validateMerchantCredit(accountCode: string, merchantProfileId: string): Promise<{ ok: boolean; error?: string }> {
    if (accountCode === '1100') {
      return {
        ok: false,
        error: 'WALLET_COMMERCANT_BLOCKED: Le compte 1100 (Wallet Commercants) est desactive. Utiliser le compte 2000 (Dettes Commercants) pour les credits marchands.',
      };
    }

    const activation = await this.checkActivation(merchantProfileId);
    if (!activation.canOperate) {
      return {
        ok: false,
        error: `MERCHANT_NOT_ACTIVATED: ${activation.currentStatus}`,
      };
    }

    return { ok: true };
  },
};
