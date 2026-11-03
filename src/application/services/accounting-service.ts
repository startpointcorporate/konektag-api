import pool from '../../infrastructure/database/pool.ts';
import type { PoolClient } from 'pg';
import type {
  FinancialTransaction,
  FinancialEntryInput,
  PostFinancialTransactionCommand,
  FinancialTransactionStatus,
  AccountingStatus,
} from '../../domain/Accounting.ts';
import crypto from 'node:crypto';
import { minorDigits } from './pay/money-unit.ts';

function hashCommand(cmd: PostFinancialTransactionCommand): string {
  const normalised = {
    transactionType: cmd.transactionType,
    businessReference: cmd.businessReference,
    currency: cmd.currency,
    amountUnit: cmd.amountUnit ?? 'MAJOR',
    entries: cmd.entries.map(e => ({
      accountCode: e.accountCode,
      partyId: e.partyId ?? null,
      side: e.side,
      amount: e.amount,
      description: e.description ?? null,
    })),
    metadata: Object.fromEntries(Object.entries(cmd.metadata ?? {}).filter(([, value]) => value != null)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
}

async function findExistingByIdempotencyKey(key: string) {
  const { rows } = await pool.query(
    `SELECT id, idempotency_key, transaction_type, business_reference, currency, amount_unit, status,
             accounting_status, erpnext_voucher_type, erpnext_voucher_id, error_message,
             created_at, completed_at, failed_at, accounting_posted_at,
             legal_entity_id, counterparty_entity_id, corridor_id, operation_id, source_operation_id,
             position_id, klot_id, regulatory_profile_id, regulated_actor_id, regulated_execution_ref, value_date
     FROM konektag.financial_transactions
     WHERE idempotency_key = $1`,
    [key],
  );
  if (rows.length === 0) return null;
  return rows[0] as FinancialTransaction;
}

async function findEntriesForTransaction(transactionId: string) {
  const { rows } = await pool.query(
    `SELECT account_code, party_id, entry_side, amount, description
     FROM konektag.ledger_entries
     WHERE transaction_id = $1
     ORDER BY created_at`,
    [transactionId],
  );
  return rows;
}

export const accountingService = {
  /**
   * Post a complete financial transaction atomically.
   *
   * 1. Checks idempotency — if the same key exists with matching content, returns the existing.
   * 2. Creates financial_transactions header.
   * 3. Creates all ledger_entries.
   * 4. The deferred constraint trigger verifies debit = credit at COMMIT.
   * 5. Inserts an accounting_outbox event for the ERPNext worker.
   * 6. COMMIT or ROLLBACK as a single unit.
   */
  async postTransaction(cmd: PostFinancialTransactionCommand, transactionClient?: PoolClient): Promise<{
    success: boolean;
    financialTransactionId: string;
    created: boolean;
    error?: string;
  }> {
    const requestHash = hashCommand(cmd);

    // Vérification idempotence avant ouverture transaction
    const existing = await findExistingByIdempotencyKey(cmd.idempotencyKey);
    if (existing) {
      const existingEntries = await findEntriesForTransaction(existing.id);

      const existingHash = hashCommand({
        idempotencyKey: existing.idempotency_key,
        transactionType: existing.transaction_type as any,
        businessReference: existing.business_reference,
        currency: existing.currency,
        amountUnit: existing.amount_unit ?? 'MAJOR',
        entries: existingEntries.map(e => ({
          accountCode: e.account_code,
          partyId: e.party_id,
          side: e.entry_side,
          amount: Number(e.amount),
          description: e.description,
        })),
        metadata: {
          legalEntityId: (existing as any).legal_entity_id,
          counterpartyEntityId: (existing as any).counterparty_entity_id,
          corridorId: (existing as any).corridor_id,
          operationId: (existing as any).operation_id,
          sourceOperationId: (existing as any).source_operation_id,
          positionId: (existing as any).position_id,
          klotId: (existing as any).klot_id,
          regulatoryProfileId: (existing as any).regulatory_profile_id,
          regulatedActorId: (existing as any).regulated_actor_id,
          regulatedExecutionRef: (existing as any).regulated_execution_ref,
          valueDate: (existing as any).value_date,
        },
      });

      if (existingHash === requestHash) {
        return {
          success: existing.status !== 'failed',
          financialTransactionId: existing.id,
          created: false,
        };
      }

      return {
        success: false,
        financialTransactionId: existing.id,
        created: false,
        error: `Idempotency key "${cmd.idempotencyKey}" already exists with different content`,
      };
    }

    const client = transactionClient ?? await pool.connect();
    const ownsTransaction = !transactionClient;

    try {
      if (ownsTransaction) {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 30000');
      }

      // Valider les entrées
      if (cmd.entries.length < 2) {
        throw new Error('A financial transaction must have at least 2 entries (debit + credit)');
      }

      for (const entry of cmd.entries) {
        if ((cmd.amountUnit === 'MINOR' ? !Number.isSafeInteger(entry.amount) : !Number.isFinite(entry.amount)) || entry.amount <= 0) {
          throw new Error(`Entry amount must be positive, got ${entry.amount}`);
        }
      }
      if (cmd.amountUnit === 'MINOR') minorDigits(cmd.currency);

      // Créer la transaction financière (avec merchant_profile_id si fourni)
      const merchantProfileId = cmd.metadata?.merchantProfileId as string | undefined;
      const dimensions = cmd.metadata ?? {};
      if (!dimensions.legalEntityId) {
        throw new Error('legalEntityId is required before creating an accounting transaction');
      }
      const { rows: [tx]} = await client.query(
        `INSERT INTO konektag.financial_transactions
         (transaction_type, business_reference, operation_id, idempotency_key, currency, status, accounting_status, merchant_profile_id,
          legal_entity_id, counterparty_entity_id, corridor_id, position_id, regulatory_profile_id, regulated_actor_id, regulated_execution_ref,
           klot_id, source_operation_id, value_date, eligibility_decision, amount_unit)
            VALUES ($1, $2, $3, $4, $5, 'pending', 'pending', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
          RETURNING id`,
        [cmd.transactionType, cmd.businessReference, dimensions.operationId ?? null, cmd.idempotencyKey, cmd.currency, merchantProfileId || null,
          dimensions.legalEntityId ?? null, dimensions.counterpartyEntityId ?? null, dimensions.corridorId ?? null, dimensions.positionId ?? null,
         dimensions.regulatoryProfileId ?? null, dimensions.regulatedActorId ?? null, dimensions.regulatedExecutionRef ?? null,
          dimensions.klotId ?? null, dimensions.sourceOperationId ?? null, dimensions.valueDate ?? null,
          dimensions.eligibilityDecision ?? null, cmd.amountUnit ?? 'MAJOR'],
      );
      const transactionId = tx.id;

      // Créer les écritures ledger
      for (const entry of cmd.entries) {
        await client.query(
          `INSERT INTO konektag.ledger_entries
           (transaction_id, entry_type, entry_side, account_code, party_id, client_id, amount, currency,
             document_type, document_ref, description, created_by, legal_entity_id, counterparty_entity_id, corridor_id,
             operation_id, source_operation_id, position_id, klot_id, regulatory_profile_id, regulated_actor_id,
             regulated_execution_ref, value_date, amount_unit)
            VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'accounting-service', $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
          [
            transactionId,
            entry.side,
            entry.accountCode,
            entry.partyId ?? null,
            entry.clientId ?? null,
            entry.amount,
            cmd.currency,
            cmd.transactionType,
            cmd.businessReference,
            entry.description ?? cmd.description ?? null,
            dimensions.legalEntityId ?? null, dimensions.counterpartyEntityId ?? null, dimensions.corridorId ?? null,
            dimensions.operationId ?? null, dimensions.sourceOperationId ?? null, dimensions.positionId ?? null,
            dimensions.klotId ?? null, dimensions.regulatoryProfileId ?? null, dimensions.regulatedActorId ?? null,
            dimensions.regulatedExecutionRef ?? null, dimensions.valueDate ?? null, cmd.amountUnit ?? 'MAJOR',
          ],
        );
      }

      // Vérification supplémentaire de l'équilibre (le constraint trigger deferrable
      // le fera aussi au COMMIT, mais on vérifie tôt pour un message d'erreur clair)
      const { rows: [balance]} = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN entry_side = 'debit' THEN amount ELSE 0 END), 0) AS total_debit,
           COALESCE(SUM(CASE WHEN entry_side = 'credit' THEN amount ELSE 0 END), 0) AS total_credit
         FROM konektag.ledger_entries
         WHERE transaction_id = $1`,
        [transactionId],
      );

      if (balance.total_debit !== balance.total_credit) {
        throw new Error(
          `Unbalanced transaction: debit ${balance.total_debit} ≠ credit ${balance.total_credit}`,
        );
      }

      // Marquer la transaction comme completed
      await client.query(
        `UPDATE konektag.financial_transactions
         SET status = 'completed', completed_at = now()
         WHERE id = $1`,
        [transactionId],
      );

      // Créer l'événement outbox comptable
      const { rows: [outbox]} = await client.query(
        `INSERT INTO konektag.accounting_outbox
         (financial_transaction_id, event_type, payload, status, next_attempt_at)
         VALUES ($1, 'AccountingRequested', $2, 'pending', now())
         RETURNING id`,
        [transactionId, JSON.stringify({
          transactionType: cmd.transactionType,
          businessReference: cmd.businessReference,
          currency: cmd.currency,
          amountUnit: cmd.amountUnit ?? 'MAJOR',
          entries: cmd.entries.map(e => ({
            accountCode: e.accountCode,
            side: e.side,
            amount: e.amount.toString(),
          })),
        })],
      );

      // Lier l'outbox à la transaction
      await client.query(
        `UPDATE konektag.financial_transactions
         SET outbox_event_id = $1
         WHERE id = $2`,
        [outbox.id, transactionId],
      );

      if (ownsTransaction) await client.query('COMMIT');

      return {
        success: true,
        financialTransactionId: transactionId,
        created: true,
      };

    } catch (error) {
      if (ownsTransaction) await client.query('ROLLBACK');
      return {
        success: false,
        financialTransactionId: '',
        created: false,
        error: (error as Error).message,
      };
    } finally {
      if (ownsTransaction) client.release();
    }
  },
};
