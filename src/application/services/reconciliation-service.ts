import type { PoolClient } from 'pg';

export interface ReconciliationResult {
  gl: string;
  rail: string | null;
  expectedBalance: number;
  actualBalance: number;
  difference: number;
  status: ReconciliationStatus;
  evidence?: Record<string, unknown>;
}

export type ReconciliationStatus = 'PENDING' | 'MATCHED' | 'MISMATCH' | 'INVESTIGATING' | 'RESOLVED';

export class ReconciliationService {
  private static readonly EQUATION_VERSION = 'V3-1';
  private static readonly TOLERANCE = 0.005;
  async reconcileAcquisition(
    client: PoolClient,
    date: string,
    gl: string
  ): Promise<ReconciliationResult> {
    const { rows: [expected] } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM konektag.acquisition_confirmations
       WHERE status = 'PROCESSED' AND created_at::date = $1`,
      [date]
    );

    const { rows: [actual] } = await client.query(
      `SELECT COALESCE(SUM(le.amount), 0) as total
       FROM konektag.ledger_entries le
       JOIN konektag.financial_transactions ft ON le.transaction_id = ft.id
       WHERE le.entry_side = 'credit' AND le.account_code = '1100'
         AND ft.status = 'completed' AND ft.created_at::date = $1`,
      [date]
    );

    const expectedValue = parseFloat(expected.total);
    const actualValue = parseFloat(actual.total);
    const difference = expectedValue - actualValue;

    return {
      gl,
      rail: 'acquisition',
      expectedBalance: expectedValue,
      actualBalance: actualValue,
      difference,
      status: Math.abs(difference) <= ReconciliationService.TOLERANCE ? 'MATCHED' : 'MISMATCH',
    };
  }

  async saveReconciliation(
    client: PoolClient,
    result: ReconciliationResult,
    date: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO konektag.daily_reconciliations
        (reconciliation_date, gl_name, rail, expected_balance, actual_balance, difference, status, equation_version, calculation_evidence, blocks_settlement, blocks_clearing, reconciled_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, now())
       ON CONFLICT (reconciliation_date, gl_name, rail) DO UPDATE
        SET expected_balance = $4, actual_balance = $5, difference = $6, status = $7, equation_version = $8, calculation_evidence = $9, blocks_settlement = $10, blocks_clearing = $10, reconciled_at = now(), updated_at = now()`,
        [date, result.gl, result.rail, result.expectedBalance, result.actualBalance, result.difference, result.status, ReconciliationService.EQUATION_VERSION, JSON.stringify({ expected: result.expectedBalance, actual: result.actualBalance, difference: result.difference, rail: result.rail, ...result.evidence }), result.status === 'MISMATCH']
    );

  }

  async reconcileMerchantDebt(client: PoolClient, date: string, legalEntityId: string, currency: string): Promise<ReconciliationResult> {
    const { rows: [expected] } = await client.query(
      `SELECT COALESCE(SUM(s.net_amount), 0) AS total
       FROM konektag.merchant_sales s
       WHERE s.legal_entity_id = $1 AND s.currency = $2 AND s.deleted_at IS NULL
         AND s.created_at::date <= $3 AND s.status <> 'CANCELLED'`, [legalEntityId, currency, date],
    );
    const { rows: [settled] } = await client.query(
      `SELECT COALESCE(SUM(ms.net_amount), 0) AS total FROM konektag.merchant_settlements ms
       WHERE ms.legal_entity_id = $1 AND ms.currency = $2 AND ms.status = 'SETTLED'
         AND ms.settlement_date <= $3 AND ms.deleted_at IS NULL`, [legalEntityId, currency, date],
    );
    const { rows: [actual] } = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN le.entry_side = 'credit' THEN le.amount ELSE -le.amount END), 0) AS total
       FROM konektag.ledger_entries le WHERE le.legal_entity_id = $1 AND le.currency = $2 AND le.account_code = '2000'
         AND le.created_at::date <= $3`, [legalEntityId, currency, date],
    );
    const expectedBalance = Number(expected.total) - Number(settled.total);
    const actualBalance = Number(actual.total);
    return this.result(`merchant_debt:${legalEntityId.slice(0, 32)}`, currency, expectedBalance, actualBalance);
  }

  async reconcileSettlementBank(client: PoolClient, date: string, legalEntityId: string, currency: string): Promise<ReconciliationResult> {
    const { rows: [expected] } = await client.query(
      `SELECT COALESCE(SUM(net_amount), 0) AS total FROM konektag.merchant_settlements
       WHERE legal_entity_id = $1 AND currency = $2 AND status = 'SETTLED' AND settlement_date = $3 AND deleted_at IS NULL`,
      [legalEntityId, currency, date],
    );
    const { rows: [actual] } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM konektag.ledger_entries
       WHERE legal_entity_id = $1 AND currency = $2 AND account_code = '1100' AND entry_side = 'credit' AND created_at::date = $3`,
      [legalEntityId, currency, date],
    );
    return this.result(`settlement_bank:${legalEntityId.slice(0, 32)}`, currency, Number(expected.total), Number(actual.total));
  }

  async reconcileIntercompany(client: PoolClient, date: string, legalEntityId: string, counterpartyEntityId: string, currency: string): Promise<ReconciliationResult> {
    const { rows: [positions] } = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM konektag.intercompany_positions
       WHERE currency = $1 AND value_date <= $2 AND status <> 'CANCELLED'
         AND ((legal_entity_a_id = $3 AND legal_entity_b_id = $4) OR (legal_entity_a_id = $4 AND legal_entity_b_id = $3))`,
      [currency, date, legalEntityId, counterpartyEntityId],
    );
    const { rows: [ledger] } = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN entry_side = 'credit' THEN amount ELSE -amount END), 0) AS total
       FROM konektag.ledger_entries WHERE currency = $1 AND legal_entity_id IN ($3, $4)
         AND account_code IN ('1200', '2100') AND created_at::date <= $2`,
      [currency, date, legalEntityId, counterpartyEntityId],
    );
    return this.result(`intercompany:${legalEntityId}:${counterpartyEntityId}`, currency, Number(positions.total), Math.abs(Number(ledger.total)));
  }

  async reconcileClearingSnapshots(client: PoolClient, date: string, legalEntityId: string): Promise<ReconciliationResult> {
    const { rows: [expected] } = await client.query(
      `SELECT COALESCE(SUM(position_count), 0) AS total FROM konektag.clearing_batches
       WHERE legal_entity_id = $1 AND period_end <= $2 AND deleted_at IS NULL`, [legalEntityId, date],
    );
    const { rows: [actual] } = await client.query(
      `SELECT COUNT(*) AS total FROM konektag.clearing_batch_positions cbp
       JOIN konektag.clearing_batches cb ON cb.id = cbp.clearing_batch_id
       WHERE cb.legal_entity_id = $1 AND cb.period_end <= $2 AND cb.deleted_at IS NULL`, [legalEntityId, date],
    );
    return this.result(`clearing_snapshots:${legalEntityId}`, 'snapshot_count', Number(expected.total), Number(actual.total));
  }

  private result(gl: string, rail: string, expectedBalance: number, actualBalance: number): ReconciliationResult {
    const difference = expectedBalance - actualBalance;
    if (![expectedBalance, actualBalance].every(Number.isFinite)) throw new Error('RECONCILIATION_EVIDENCE_MISSING');
    return { gl, rail, expectedBalance, actualBalance, difference, status: Math.abs(difference) <= ReconciliationService.TOLERANCE ? 'MATCHED' : 'MISMATCH' };
  }
}
