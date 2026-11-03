import type { PoolClient } from 'pg';
import { ReconciliationService, type ReconciliationResult, type ReconciliationStatus } from './reconciliation-service.ts';

export const DAILY_RECONCILIATION_CONTROLS = [
  'acquisition_rail',
  'user_gl',
  'merchant_liabilities',
  'local_bank_settlement',
  'intercompany_symmetry',
  'clearing_integrity',
] as const;

type DailyControl = typeof DAILY_RECONCILIATION_CONTROLS[number];

export interface DailyReconciliationContext {
  franceLegalEntityId: string;
  congoLegalEntityId: string;
  currency: string;
}

export interface DailyReconciliationResult {
  control: DailyControl;
  result: ReconciliationResult;
}

const SUPPORTED_STATUSES: readonly ReconciliationStatus[] = [
  'PENDING',
  'MATCHED',
  'MISMATCH',
  'INVESTIGATING',
  'RESOLVED',
];

export async function reconcileUserGl(client: PoolClient, date: string): Promise<ReconciliationResult> {
  const glScope = 'GLOBAL_USER_GL';
  const { rows: [row] } = await client.query<{ source_entry_count: string; balance: string }>(
    `SELECT COUNT(*)::int AS source_entry_count,
            COALESCE(SUM(CASE WHEN le.entry_side = 'credit' THEN le.amount ELSE -le.amount END), 0) AS balance
       FROM konektag.ledger_entries le
       JOIN konektag.financial_transactions ft ON le.transaction_id = ft.id
      WHERE ft.created_at::date = $1
        AND ft.status = 'completed'
        AND le.gl_scope = $2
        AND le.legacy_classification IS NULL`,
    [date, glScope],
  );

  const sourceEntryCount = Number(row?.source_entry_count);
  const actualBalance = Number(row?.balance);
  if (!Number.isInteger(sourceEntryCount) || sourceEntryCount <= 0 || !Number.isFinite(actualBalance)) {
    throw new Error('RECONCILIATION_EVIDENCE_MISSING');
  }

  return {
    gl: 'GL User Global',
    rail: 'daily_gl',
    expectedBalance: 0,
    actualBalance,
    difference: -actualBalance,
    status: actualBalance === 0 ? 'MATCHED' : 'MISMATCH',
    evidence: { sourceEntryCount, glScope },
  };
}

export async function runDailyReconciliation(
  client: PoolClient,
  reconciliation: ReconciliationService,
  date: string,
  context: DailyReconciliationContext,
  userGl: (client: PoolClient, date: string) => Promise<ReconciliationResult> = reconcileUserGl,
): Promise<DailyReconciliationResult[]> {
  const executions: Array<{ control: DailyControl; execute: () => Promise<ReconciliationResult> }> = [
    { control: 'acquisition_rail', execute: () => reconciliation.reconcileAcquisition(client, date, 'GL User Global') },
    { control: 'user_gl', execute: () => userGl(client, date) },
    { control: 'merchant_liabilities', execute: () => reconciliation.reconcileMerchantDebt(client, date, context.franceLegalEntityId, context.currency) },
    { control: 'local_bank_settlement', execute: () => reconciliation.reconcileSettlementBank(client, date, context.franceLegalEntityId, context.currency) },
    { control: 'intercompany_symmetry', execute: () => reconciliation.reconcileIntercompany(client, date, context.franceLegalEntityId, context.congoLegalEntityId, context.currency) },
    { control: 'clearing_integrity', execute: () => reconciliation.reconcileClearingSnapshots(client, date, context.franceLegalEntityId) },
  ];

  const settled = await Promise.allSettled(executions.map(({ execute }) => execute()));
  const results = settled.map((outcome, index) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    if (!outcome.value) throw new Error(`RECONCILIATION_RESULT_MISSING:${executions[index].control}`);
    return { control: executions[index].control, result: outcome.value };
  });

  validateDailyResults(results);

  const persisted = await Promise.allSettled(results.map(({ result }) => reconciliation.saveReconciliation(client, result, date)));
  const persistenceFailure = persisted.find((outcome) => outcome.status === 'rejected');
  if (persistenceFailure?.status === 'rejected') throw persistenceFailure.reason;

  return results;
}

function validateDailyResults(results: DailyReconciliationResult[]): void {
  if (results.length !== DAILY_RECONCILIATION_CONTROLS.length) throw new Error('RECONCILIATION_CONTROL_COUNT_INVALID');
  const controls = new Set(results.map(({ control }) => control));
  if (controls.size !== DAILY_RECONCILIATION_CONTROLS.length || DAILY_RECONCILIATION_CONTROLS.some((control) => !controls.has(control))) {
    throw new Error('RECONCILIATION_CONTROL_SET_INVALID');
  }
  for (const { control, result } of results) {
    if (!result || !SUPPORTED_STATUSES.includes(result.status)) throw new Error(`RECONCILIATION_STATUS_UNSUPPORTED:${control}`);
    if (result.status !== 'MATCHED') throw new Error(`RECONCILIATION_CONTROL_FAILED:${control}:${result.status}`);
  }
}
