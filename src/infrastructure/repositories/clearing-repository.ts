import type { PoolClient } from 'pg';

export interface ClearingBatch {
  id: string;
  batchRef: string;
  legalEntityId: string;
  counterpartyEntityId?: string;
  b2bProfileId?: string;
  periodStart: string;
  periodEnd: string;
  positionCount: number;
  netAmount: number;
  currency: string;
  status: string;
  nettingAllowed: boolean;
  financeA?: string;
  financeB?: string;
  compliance?: string;
  bankProofUrl?: string;
  fxRate?: number;
  version: number;
  grossAmount?: number;
  exceptionAmount?: number;
  settlementDate?: string | null;
  initiatedBy?: string | null;
  positions?: ClearingPosition[];
}

export interface ClearingPosition {
  positionId: string;
  legalEntityAId: string;
  legalEntityBId: string;
  direction: 'A_TO_B' | 'B_TO_A';
  amount: number;
  currency: string;
}

export class ClearingRepository {
  constructor(private client: Pick<PoolClient, 'query'>) {}

  async findById(id: string): Promise<ClearingBatch | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.clearing_batches
       WHERE (id::text = $1 OR batch_ref = $1) AND deleted_at IS NULL`,
      [id],
    );
    if (!rows[0]) return null;
    const batch = this.mapRow(rows[0]);
    const { rows: positions } = await this.client.query(
      `SELECT cbp.position_id, cbp.amount, cbp.currency, ip.legal_entity_a_id,
              ip.legal_entity_b_id, ip.direction
       FROM konektag.clearing_batch_positions cbp
       JOIN konektag.intercompany_positions ip ON ip.id = cbp.position_id
       WHERE cbp.clearing_batch_id = $1 ORDER BY cbp.snapshot_at`,
      [batch.id],
    );
    batch.positions = positions.map(row => ({
      positionId: row.position_id,
      legalEntityAId: row.legal_entity_a_id,
      legalEntityBId: row.legal_entity_b_id,
      direction: row.direction,
      amount: Number(row.amount),
      currency: row.currency,
    }));
    return batch;
  }

  async list(filters: { legalEntityId?: string; status?: string; limit?: number } = {}): Promise<ClearingBatch[]> {
    const conditions = ['deleted_at IS NULL'];
    const values: unknown[] = [];
    if (filters.legalEntityId) {
      values.push(filters.legalEntityId);
      conditions.push(`(
        legal_entity_id::text = $${values.length} OR counterparty_entity_id::text = $${values.length}
        OR EXISTS (SELECT 1 FROM konektag.legal_entities le
          WHERE le.id IN (legal_entity_id, counterparty_entity_id) AND le.code = $${values.length})
      )`);
    }
    if (filters.status) {
      values.push(filters.status);
      conditions.push(`status = $${values.length}`);
    }
    values.push(Math.min(Math.max(filters.limit ?? 30, 1), 100));
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.clearing_batches WHERE ${conditions.join(' AND ')}
       ORDER BY period_start DESC LIMIT $${values.length}`,
      values,
    );
    return rows.map(row => this.mapRow(row));
  }

  async snapshotPositions(
    batchId: string,
    legalEntityA: string,
    legalEntityB: string,
    periodStart: string,
    periodEnd: string,
    currency: string
  ): Promise<number> {
    const { rowCount } = await this.client.query(
      `INSERT INTO konektag.clearing_batch_positions (clearing_batch_id, position_id, amount, currency)
       SELECT $1, ip.id, ip.amount, ip.currency
       FROM konektag.intercompany_positions ip
       WHERE ip.status = 'OPEN'
         AND ip.legal_entity_a = $2 AND ip.legal_entity_b = $3
         AND ip.created_at >= $4 AND ip.created_at <= $5
         AND ip.currency = $6
         AND NOT EXISTS (
           SELECT 1 FROM konektag.clearing_batch_positions cbp
           WHERE cbp.position_id = ip.id
         )
       ON CONFLICT (clearing_batch_id, position_id) DO NOTHING`,
      [batchId, legalEntityA, legalEntityB, periodStart, periodEnd, currency]
    );
    return rowCount || 0;
  }

  async calculateTotals(batchId: string): Promise<{ count: number; netAmount: number }> {
    const { rows } = await this.client.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(amount), 0) as total
       FROM konektag.clearing_batch_positions
       WHERE clearing_batch_id = $1`,
      [batchId]
    );
    return { count: parseInt(rows[0].cnt), netAmount: parseFloat(rows[0].total) };
  }

  async recordApproval(batchId: string, approverId: string, role: string): Promise<boolean> {
    const { rowCount } = await this.client.query(
      `INSERT INTO konektag.admin_approvals (entity_type, entity_id, approver_id, approval_role, decision)
       VALUES ('clearing_batch', $1, $2, $3, 'APPROVED')
       ON CONFLICT (entity_type, entity_id, approver_id, approval_role) DO NOTHING`,
      [batchId, approverId, role]
    );
    return (rowCount ?? 0) > 0;
  }

  async checkTripleApproval(batchId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `SELECT COUNT(DISTINCT approver_id) as cnt
       FROM konektag.admin_approvals
       WHERE entity_type = 'clearing_batch' AND entity_id = $1 AND decision = 'APPROVED'`,
      [batchId]
    );
    return parseInt(rows[0].cnt) >= 3;
  }

  async settle(batchId: string, bankProofUrl?: string): Promise<boolean> {
    const status = bankProofUrl ? 'SETTLED' : 'BANK_PENDING';
    const { rowCount } = await this.client.query(
      `UPDATE konektag.clearing_batches
       SET status = $1, bank_proof_url = COALESCE($2, bank_proof_url),
           settlement_date = CASE WHEN $1 = 'SETTLED' THEN CURRENT_DATE ELSE NULL END,
           updated_at = now(), version = version + 1
       WHERE id = $3`,
      [status, bankProofUrl, batchId]
    );
    return (rowCount ?? 0) > 0;
  }

  private mapRow(row: any): ClearingBatch {
    return {
      id: row.id,
      batchRef: row.batch_ref,
      legalEntityId: row.legal_entity_id,
      counterpartyEntityId: row.counterparty_entity_id,
      b2bProfileId: row.b2b_profile_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      positionCount: Number(row.position_count ?? 0),
      netAmount: Number(row.net_amount ?? 0),
      grossAmount: Number(row.gross_amount ?? 0),
      exceptionAmount: Number(row.exception_amount ?? 0),
      currency: row.currency,
      status: row.status,
      nettingAllowed: Boolean(row.netting_allowed),
      financeA: row.finance_a_approved_by,
      financeB: row.finance_b_approved_by,
      compliance: row.compliance_approved_by,
      bankProofUrl: row.bank_proof_url,
      settlementDate: row.settlement_date,
      initiatedBy: row.initiated_by,
      fxRate: row.fx_rate == null ? undefined : Number(row.fx_rate),
      version: row.version,
    };
  }
}
