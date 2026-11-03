import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { FinancialEligibilityEngine } from '../../application/services/financial-eligibility-engine.ts';
import type {
  FinancialOperationCommand,
  FinancialOperationResult,
} from '../../application/services/financial-transaction-service.ts';
import type { AuthorizedOperation } from '../../domain/RegulatoryProfile.ts';

export interface V3OperationCommand {
  idempotencyKey: string;
  operationId: string;
  operation: AuthorizedOperation;
  legalEntityId?: string;
  counterpartyEntityId?: string;
  corridorId: string;
  regulatoryProfileId: string;
  regulatedActorId?: string;
  regulatedExecutionRef?: string;
  positionId?: string;
  klotId?: string;
  sourceOperationId?: string;
  currency: string;
  valueDate: string;
  eligibilityDecision: string;
  entries: Array<{
    /** Persisted as NULL when absent (network/platform entries). */
    clientId?: string;
    partyId?: string;
    accountCode: string;
    side: 'debit' | 'credit';
    amount: number;
    description?: string;
  }>;
  auditEvent: string;
  auditMetadata?: Record<string, unknown>;
}

export class FinancialOperationRepository {
  constructor(private client: PoolClient) {}

  async createTransaction(command: V3OperationCommand): Promise<string> {
    const cmdHash = crypto.createHash('sha256')
      .update(JSON.stringify({
        operationId: command.operationId,
        operation: command.operation,
        currency: command.currency,
        entries: command.entries.map(e => ({ side: e.side, amount: e.amount, accountCode: e.accountCode })),
      }))
      .digest('hex').slice(0, 16);

    const { rows: [tx] } = await this.client.query(
      `INSERT INTO konektag.financial_transactions
       (transaction_type, business_reference, operation_id, idempotency_key,
        command_hash, currency, status, accounting_status,
        legal_entity_id, counterparty_entity_id, corridor_id,
        regulatory_profile_id, regulated_actor_id, regulated_execution_ref,
        klot_id, source_operation_id, value_date, eligibility_decision)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'pending',
               $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = $4
       RETURNING id`,
      [
        command.operation, command.operationId, command.operationId, command.idempotencyKey,
        cmdHash, command.currency,
        command.legalEntityId || null, command.counterpartyEntityId || null, command.corridorId,
        command.regulatoryProfileId, command.regulatedActorId || null, command.regulatedExecutionRef || null,
        command.klotId || null, command.sourceOperationId || null, command.valueDate,
        command.eligibilityDecision,
      ]
    );

    return tx.id;
  }

  async createLedgerEntry(
    transactionId: string,
    entry: V3OperationCommand['entries'][0],
    command: V3OperationCommand
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO konektag.ledger_entries
       (transaction_id, entry_type, entry_side, account_code, party_id, client_id,
        amount, currency, document_type, document_ref, description, created_by,
        legal_entity_id, counterparty_entity_id, corridor_id, operation_id, source_operation_id,
        position_id, klot_id, regulatory_profile_id, regulated_actor_id, regulated_execution_ref,
        value_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'financial-operation-service',
               $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        transactionId,
        entry.side, entry.side, entry.accountCode, entry.partyId || null, entry.clientId || null,
        entry.amount, command.currency, command.operation, command.operationId,
        entry.description || null,
        command.legalEntityId || null, command.counterpartyEntityId || null, command.corridorId,
         command.operationId, command.sourceOperationId || null,
         command.positionId || null,
        command.klotId || null, command.regulatoryProfileId,
        command.regulatedActorId || null, command.regulatedExecutionRef || null,
        command.valueDate,
      ]
    );
  }

  async completeTransaction(transactionId: string): Promise<void> {
    await this.client.query(
      `UPDATE konektag.financial_transactions
       SET status = 'completed', completed_at = now()
       WHERE id = $1`,
      [transactionId]
    );
  }

  async allocateKLot(klotId: string, quantity: number, transactionId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `UPDATE konektag.klots
       SET remaining_quantity = remaining_quantity - $2
       WHERE id = $1 AND remaining_quantity >= $2
       RETURNING id`,
      [klotId, quantity]
    );

    if (rows.length === 0) return false;

    await this.client.query(
      `INSERT INTO konektag.klot_allocations (klot_id, transaction_id, allocated_quantity)
       VALUES ($1, $2, $3)`,
      [klotId, transactionId, quantity]
    );

    return true;
  }

  async createOutboxEvent(transactionId: string, payload: unknown): Promise<string> {
    const { rows: [outbox] } = await this.client.query(
      `INSERT INTO konektag.accounting_outbox
       (financial_transaction_id, event_type, payload, status, next_attempt_at)
       VALUES ($1, 'AccountingRequested', $2, 'pending', now())
       RETURNING id`,
      [transactionId, JSON.stringify(payload)]
    );
    return outbox.id;
  }

  async createAuditLog(
    transactionId: string,
    eventType: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const cleanMeta = { ...metadata };
    delete cleanMeta.email;
    delete cleanMeta.phone;
    delete cleanMeta.documentId;
    delete cleanMeta.kycContent;

    await this.client.query(
      `INSERT INTO konektag.audit_logs
        (correlation_id, entity_type, entity_id, event_type, changed_by, metadata)
        VALUES ($1, 'financial_transaction', $2, $3, $4, $5)`,
       [crypto.randomUUID(), transactionId, eventType, 'system', JSON.stringify(cleanMeta)]
    );
  }

  async verifyBalance(transactionId: string): Promise<{ debit: number; credit: number }> {
    const { rows: [balance] } = await this.client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN entry_side = 'debit' THEN amount ELSE 0 END), 0) AS total_debit,
         COALESCE(SUM(CASE WHEN entry_side = 'credit' THEN amount ELSE 0 END), 0) AS total_credit
       FROM konektag.ledger_entries
       WHERE transaction_id = $1`,
      [transactionId]
    );
    return {
      debit: parseFloat(balance.total_debit),
      credit: parseFloat(balance.total_credit),
    };
  }

  async findOperationById(operationId: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `SELECT id FROM konektag.financial_transactions WHERE operation_id = $1`,
      [operationId]
    );
    return rows.length > 0;
  }

  async findByIdempotencyKey(key: string): Promise<{
    id: string; status: string; commandHash: string;
  } | null> {
    const { rows } = await this.client.query(
      `SELECT id, status, command_hash FROM konektag.financial_transactions
       WHERE idempotency_key = $1`,
      [key]
    );
    return rows[0] ? { id: rows[0].id, status: rows[0].status, commandHash: rows[0].command_hash } : null;
  }
}
