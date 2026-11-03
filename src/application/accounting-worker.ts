import pool from '../infrastructure/database/pool.ts';
import type { FinancialTransaction } from '../domain/Accounting.ts';
import type { AccountingEntryView } from '../infrastructure/adapters/accounting-destination.ts';
import { ErpNextAccountingDestination } from '../infrastructure/adapters/accounting-destination.ts';
import {
  PROCESS_IDS,
  recordWorkerHeartbeat,
  registerWorkerRun,
} from './services/process-evidence-service.ts';

const MAX_ATTEMPTS = 10;
const BATCH_SIZE = 10;
const BACKOFF_BASE_MS = 5_000;

const destination = new ErpNextAccountingDestination();

let running = false;
let interval: ReturnType<typeof setInterval> | null = null;
// GAP-024: durable evidence run identity for this worker process.
let evidenceRunId: string | null = null;

export function startAccountingWorker(): void {
  console.log('[AccountingWorker] startAccountingWorker() CALLED');
  if (running) {
    console.log('[AccountingWorker] Already running, skipping');
    return;
  }
  running = true;

  // GAP-024: register durable worker evidence (never breaks startup; health
  // evaluation fails closed when evidence is missing or stale).
  registerWorkerRun(PROCESS_IDS.accountingWorker)
    .then(runId => { evidenceRunId = runId; })
    .catch(err => console.error('[AccountingWorker] Evidence registration failed:', err));

  processPending().catch(err => console.error('[AccountingWorker] Initial error:', err));

  interval = setInterval(() => {
    processPending().catch(err => console.error('[AccountingWorker] Poll error:', err));
  }, 10_000);

    console.log('[AccountingWorker] Started (poll every 10s)');
}

async function processPending(): Promise<void> {
  // GAP-024: liveness heartbeat — the worker keeps serving even when evidence
  // persistence fails; health evaluation then fails closed on stale evidence.
  if (evidenceRunId) {
    try {
      await recordWorkerHeartbeat(PROCESS_IDS.accountingWorker, evidenceRunId);
    } catch (err) {
      console.error('[AccountingWorker] Evidence heartbeat failed:', (err as Error).message);
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 30000');
    await client.query('SET LOCAL lock_timeout = 5000');

    const { rows: events } = await client.query(
      `SELECT * FROM konektag.accounting_outbox
       WHERE status = 'pending'
         AND next_attempt_at <= now()
         AND attempt_count < $1
       ORDER BY next_attempt_at, created_at, id
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, BATCH_SIZE],
    );

    await client.query('COMMIT');

    if (events.length > 0) {
      console.log(`[AccountingWorker] Processing ${events.length} event(s)`);
    }

    console.log(`[AccountingWorker] Heartbeat — polled (${events.length} pending)`);

    for (const event of events) {
      await processEvent(event);
    }

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AccountingWorker] Batch error:', (error as Error).message);
  } finally {
    client.release();
  }
}

async function processEvent(event: any): Promise<void> {
  const logPrefix = `[AccountingWorker:${event.id.slice(0, 8)}]`;

  try {
    // Passer en processing
    await pool.query(
      `UPDATE konektag.accounting_outbox
       SET status = 'processing', last_attempt_at = now()
       WHERE id = $1`,
      [event.id],
    );

    // Charger la transaction financière
    const { rows: [tx] } = await pool.query(
      `SELECT * FROM konektag.financial_transactions WHERE id = $1`,
      [event.financial_transaction_id],
    );
    if (!tx) {
      throw new Error(`Financial transaction ${event.financial_transaction_id} not found`);
    }

    // Charger les écritures ledger
    const { rows: entries } = await pool.query(
      `SELECT account_code, entry_side, amount, description
       FROM konektag.ledger_entries
       WHERE transaction_id = $1
       ORDER BY created_at`,
      [tx.id],
    );
    if (entries.length === 0) {
      throw new Error(`No ledger entries for transaction ${tx.id}`);
    }

    // Vérifier l'équilibre
    const totalDebit = entries
      .filter((e: any) => e.entry_side === 'debit')
      .reduce((sum: number, e: any) => sum + Number(e.amount), 0);
    const totalCredit = entries
      .filter((e: any) => e.entry_side === 'credit')
      .reduce((sum: number, e: any) => sum + Number(e.amount), 0);

    if (totalDebit !== totalCredit) {
      throw new Error(
        `Unbalanced transaction ${tx.id}: debit ${totalDebit} ≠ credit ${totalCredit}`,
      );
    }

    // Appeler l'adaptateur ERPNext
    const viewEntries: AccountingEntryView[] = entries.map((e: any) => ({
      accountCode: e.account_code,
      side: e.entry_side,
      amount: Number(e.amount),
      amountUnit: tx.amount_unit ?? 'MAJOR',
      currency: tx.currency || 'XOF',
      description: e.description,
    }));

    const result = await destination.post(tx as FinancialTransaction, viewEntries);

    if (result.success && result.erpnextVoucherId) {
      // Succès : marquer la transaction comme comptabilisée
      const accountingClient = await pool.connect();
      try {
        await accountingClient.query('BEGIN');

        await accountingClient.query(
          `UPDATE konektag.financial_transactions
           SET accounting_status = 'posted',
               erpnext_voucher_type = $2,
               erpnext_voucher_id = $3,
               accounting_posted_at = now()
           WHERE id = $1`,
          [tx.id, result.erpnextVoucherType, result.erpnextVoucherId],
        );

        await accountingClient.query(
          `UPDATE konektag.accounting_outbox
           SET status = 'processed', processed_at = now()
           WHERE id = $1`,
          [event.id],
        );

        await accountingClient.query('COMMIT');
        console.log(`${logPrefix} Posted to ERPNext: ${result.erpnextVoucherType} ${result.erpnextVoucherId}`);
      } catch (err) {
        await accountingClient.query('ROLLBACK');
        throw err;
      } finally {
        accountingClient.release();
      }

    } else {
      // Échec ERPNext
      throw new Error(result.error || 'ERPNext posting failed');
    }

  } catch (error) {
    const errMsg = (error as Error).message;
    const newAttemptCount = event.attempt_count + 1;
    const isFinal = newAttemptCount >= MAX_ATTEMPTS;
    const backoffMs = BACKOFF_BASE_MS * Math.pow(2, event.attempt_count);

    console.error(`${logPrefix} Failed (${newAttemptCount}/${MAX_ATTEMPTS}): ${errMsg}`);

    await pool.query(
      `UPDATE konektag.accounting_outbox
       SET status = $2,
           attempt_count = $3,
           last_error = $4,
           next_attempt_at = now() + interval '${backoffMs} milliseconds',
           last_attempt_at = now()
       WHERE id = $1`,
      [event.id, isFinal ? 'failed' : 'pending', newAttemptCount, errMsg.slice(0, 500)],
    );

    if (isFinal) {
      await pool.query(
        `UPDATE konektag.financial_transactions
         SET accounting_status = 'failed', failed_at = now(), error_message = $2
         WHERE id = $1`,
        [event.financial_transaction_id, errMsg.slice(0, 500)],
      );
    }
  }
}

export function stopAccountingWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  running = false;
  console.log('[AccountingWorker] Stopped');
}
