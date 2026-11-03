import type { PoolClient } from 'pg';

export interface MerchantSettlement {
  id: string;
  settlementRef: string;
  merchantProfileId: string;
  legalEntityId: string;
  periodStart: string;
  periodEnd: string;
  grossAmount: number;
  netAmount: number;
  taxAmount: number;
  commissionAmount: number;
  currency: string;
  status: string;
  version: number;
  merchantName?: string;
  legalEntityCode?: string;
  salesCount?: number;
  settlementDate?: string | null;
  confirmedAt?: string | null;
  createdAt?: string;
  approvedBy?: string | null;
  confirmedBy?: string | null;
  bankProofUrl?: string | null;
}

export interface MerchantSettlementFilters {
  legalEntityId?: string;
  merchantProfileId?: string;
  status?: string;
  userId?: string;
  limit?: number;
}

export class MerchantSettlementRepository {
  constructor(private client: Pick<PoolClient, 'query'>) {}

  async create(settlement: Omit<MerchantSettlement, 'id' | 'settlementRef' | 'version'>): Promise<MerchantSettlement> {
    const ref = `STL-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const { rows: [row] } = await this.client.query(
      `INSERT INTO konektag.merchant_settlements
       (settlement_ref, merchant_profile_id, legal_entity_id, period_start, period_end,
        gross_amount, net_amount, tax_amount, commission_amount, currency, status, prepared_by, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PREPARED', $11, 0)
       RETURNING *`,
      [ref, settlement.merchantProfileId, settlement.legalEntityId,
       settlement.periodStart, settlement.periodEnd,
       settlement.grossAmount, settlement.netAmount, settlement.taxAmount,
       settlement.commissionAmount, settlement.currency,
       'system']
    );
    return this.mapRow(row);
  }

  async findById(id: string): Promise<MerchantSettlement | null> {
    const { rows } = await this.client.query(
      `SELECT ms.*, mp.business_name AS merchant_name, le.code AS legal_entity_code,
              COUNT(mss.sale_id)::int AS sales_count
       FROM konektag.merchant_settlements ms
       JOIN konektag.merchant_profiles mp ON mp.id = ms.merchant_profile_id
       JOIN konektag.legal_entities le ON le.id = ms.legal_entity_id
       LEFT JOIN konektag.merchant_settlement_sales mss ON mss.settlement_id = ms.id
       WHERE (ms.id::text = $1 OR ms.settlement_ref = $1) AND ms.deleted_at IS NULL
       GROUP BY ms.id, mp.business_name, le.code`,
      [id]
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async list(filters: MerchantSettlementFilters = {}): Promise<MerchantSettlement[]> {
    const conditions = ['ms.deleted_at IS NULL'];
    const values: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      values.push(value);
      conditions.push(condition.replaceAll('?', `$${values.length}`));
    };
    if (filters.legalEntityId) add('(ms.legal_entity_id::text = ? OR le.code = ?)', filters.legalEntityId);
    if (filters.merchantProfileId) add('ms.merchant_profile_id::text = ?', filters.merchantProfileId);
    if (filters.status) add('ms.status = ?', filters.status);
    if (filters.userId) add(`EXISTS (
      SELECT 1 FROM konektag.merchant_memberships mm
      WHERE mm.merchant_profile_id = ms.merchant_profile_id
        AND mm.user_id = ? AND mm.status = 'active'
    )`, filters.userId);
    values.push(Math.min(Math.max(filters.limit ?? 50, 1), 100));

    const { rows } = await this.client.query(
      `SELECT ms.*, mp.business_name AS merchant_name, le.code AS legal_entity_code,
              COUNT(mss.sale_id)::int AS sales_count
       FROM konektag.merchant_settlements ms
       JOIN konektag.merchant_profiles mp ON mp.id = ms.merchant_profile_id
       JOIN konektag.legal_entities le ON le.id = ms.legal_entity_id
       LEFT JOIN konektag.merchant_settlement_sales mss ON mss.settlement_id = ms.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY ms.id, mp.business_name, le.code
       ORDER BY ms.created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(row => this.mapRow(row));
  }

  async linkSales(settlementId: string, saleIds: string[]): Promise<void> {
    for (const saleId of saleIds) {
      await this.client.query(
        `INSERT INTO konektag.merchant_settlement_sales (settlement_id, sale_id)
         VALUES ($1, $2) ON CONFLICT (sale_id) DO NOTHING`,
        [settlementId, saleId]
      );
    }
  }

  async addEvidence(settlementId: string, evidenceType: string, url: string, contentHash?: string): Promise<void> {
    await this.client.query(
      `INSERT INTO konektag.settlement_evidence (settlement_id, evidence_type, evidence_url, content_hash)
       VALUES ($1, $2, $3, $4)`,
      [settlementId, evidenceType, url, contentHash || null]
    );
  }

  async approve(settlementId: string, approverId: string, role: string): Promise<boolean> {
    const { rows: [existing] } = await this.client.query(
      `SELECT id FROM konektag.admin_approvals
       WHERE entity_type = 'merchant_settlement' AND entity_id = $1
         AND approver_id = $2 AND approval_role = $3`,
      [settlementId, approverId, role]
    );
    if (existing) return false;

    await this.client.query(
      `INSERT INTO konektag.admin_approvals (entity_type, entity_id, approver_id, approval_role, decision)
       VALUES ('merchant_settlement', $1, $2, $3, 'APPROVED')`,
      [settlementId, approverId, role]
    );

    const { rows: [settlement] } = await this.client.query(
      `SELECT prepared_by FROM konektag.merchant_settlements WHERE id = $1`,
      [settlementId]
    );

    if (settlement.prepared_by === approverId) {
      await this.client.query(
        `UPDATE konektag.admin_approvals SET decision = 'REJECTED', comment = 'Preparer cannot approve own settlement'
         WHERE entity_type = 'merchant_settlement' AND entity_id = $1 AND approver_id = $2`,
        [settlementId, approverId]
      );
      return false;
    }

    return true;
  }

  async confirm(settlementId: string, confirmerId: string, bankProofUrl: string): Promise<boolean> {
    const { rowCount } = await this.client.query(
      `UPDATE konektag.merchant_settlements
       SET status = 'SETTLED', confirmed_by = $1, bank_proof_url = $2,
           settlement_date = CURRENT_DATE, updated_at = now(), version = version + 1
       WHERE id = $3 AND status IN ('APPROVED', 'BANK_PENDING')`,
      [confirmerId, bankProofUrl, settlementId]
    );
    return (rowCount ?? 0) > 0;
  }

  private mapRow(row: any): MerchantSettlement {
    return {
      id: row.id,
      settlementRef: row.settlement_ref,
      merchantProfileId: row.merchant_profile_id,
      legalEntityId: row.legal_entity_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      grossAmount: parseFloat(row.gross_amount),
      netAmount: parseFloat(row.net_amount),
      taxAmount: parseFloat(row.tax_amount),
      commissionAmount: parseFloat(row.commission_amount),
      currency: row.currency,
      status: row.status,
      version: row.version,
      merchantName: row.merchant_name,
      legalEntityCode: row.legal_entity_code,
      salesCount: Number(row.sales_count ?? 0),
      settlementDate: row.settlement_date,
      confirmedAt: row.settlement_date,
      createdAt: row.created_at,
      approvedBy: row.approved_by,
      confirmedBy: row.confirmed_by,
      bankProofUrl: row.bank_proof_url,
    };
  }
}
