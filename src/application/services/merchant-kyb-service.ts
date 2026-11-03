import type { PoolClient } from 'pg';

export interface KybGate {
  name: string;
  required: boolean;
  validated: boolean;
  evidence?: string;
  validatedAt?: string;
}

export interface MerchantKybStatus {
  merchantProfileId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'RE_REVIEW_DUE';
  gates: KybGate[];
  nextReviewDate?: string;
}

export class MerchantKybService {
  constructor(private client: PoolClient) {}

  async requireMerchantApproved(merchantProfileId: string): Promise<{
    approved: boolean;
    reason?: string;
  }> {
    const { rows: [mp] } = await this.client.query(
      `SELECT id, kyb_status, kyb_approved_at, kyb_next_review_date, kyb_review_date, kyb_settlement_account
       FROM konektag.merchant_profiles
       WHERE id = $1 AND deleted_at IS NULL`,
      [merchantProfileId]
    );

    if (!mp) {
      return { approved: false, reason: 'Merchant profile not found' };
    }

    if (mp.kyb_status === 'REJECTED') {
      return { approved: false, reason: 'KYB rejected' };
    }

    if (mp.kyb_status !== 'APPROVED' && mp.kyb_status !== 'MERCHANT_APPROVED') {
      return { approved: false, reason: `KYB not approved (status: ${mp.kyb_status})` };
    }

    const nextReviewDate = mp.kyb_next_review_date || mp.kyb_review_date;
    if (nextReviewDate && new Date(nextReviewDate) < new Date()) {
      return { approved: false, reason: 'KYB re-review due' };
    }

    if (!mp.kyb_approved_at || !mp.kyb_settlement_account) return { approved: false, reason: 'KYB evidence incomplete' };

    return { approved: true };
  }
}
