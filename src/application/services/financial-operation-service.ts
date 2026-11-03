import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { FinancialOperationRepository } from '../../infrastructure/repositories/financial-operation-repository.ts';
import { FinancialEligibilityEngine } from './financial-eligibility-engine.ts';
import type { AuthorizedOperation } from '../../domain/RegulatoryProfile.ts';

export interface V3OperationCommand {
  idempotencyKey: string;
  operationId: string;
  operation: AuthorizedOperation;
  userId: string;
  keycloakId: string;
  countryOfOrigin: string;
  countryOfDestination: string;
  amount: number;
  currency: string;
  rail: string;
  legalEntityId?: string;
  counterpartyEntityId?: string;
  corridorId?: string;
  regulatoryProfileId?: string;
  regulatedActorId?: string;
  regulatedExecutionRef?: string;
  positionId?: string;
  valueDate?: string;
  klotId?: string;
  klotQuantity?: number;
  sourceOperationId?: string;
  entries: Array<{
    /** Optional: network/platform entries (e.g. account 8000) carry no client dimension. */
    clientId?: string;
    partyId?: string;
    accountCode: string;
    side: 'debit' | 'credit';
    amount: number;
    description?: string;
  }>;
  reversalReason?: string;
  reversalEvidence?: Record<string, unknown>;
  reversalApprovedBy?: string;
}

export interface V3OperationResult {
  success: boolean;
  financialTransactionId: string;
  operationId: string;
  created: boolean;
  error?: string;
  eligibilityDecision?: string;
}

export class FinancialOperationService {
  private repo: FinancialOperationRepository;
  private engine: FinancialEligibilityEngine;

  constructor(private client: PoolClient, private readonly ownsTransaction = true) {
    this.repo = new FinancialOperationRepository(client);
    this.engine = new FinancialEligibilityEngine(client);
  }

  async execute(command: V3OperationCommand): Promise<V3OperationResult> {
    try {
      const debit = command.entries.filter(entry => entry.side === 'debit').reduce((sum, entry) => sum + entry.amount, 0);
      const credit = command.entries.filter(entry => entry.side === 'credit').reduce((sum, entry) => sum + entry.amount, 0);
      if (command.entries.length < 2 || debit === 0 || debit !== credit) {
        throw new Error(`Unbalanced transaction: debit ${debit} ≠ credit ${credit}`);
      }
      if (this.ownsTransaction) {
        await this.client.query('BEGIN');
        await this.client.query('SET LOCAL statement_timeout = 30000');
      }

      // 1. Idempotency check via operation_id
      const existing = await this.repo.findByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        if (this.ownsTransaction) await this.client.query('ROLLBACK');
        return {
          success: existing.status !== 'failed',
          financialTransactionId: existing.id,
          operationId: command.operationId,
          created: false,
        };
      }
      const exists = await this.repo.findOperationById(command.operationId);
      if (exists) throw new Error(`Operation ${command.operationId} already exists`);

      // 2. Eligibility evaluation
      const eligibility = await this.engine.evaluate({
        operation: command.operation,
        userId: command.userId,
        keycloakId: command.keycloakId,
        countryOfOrigin: command.countryOfOrigin,
        countryOfDestination: command.countryOfDestination,
        amount: command.amount,
        currency: command.currency,
        klotId: command.klotId || null,
        rail: command.rail as import('../../domain/RegulatoryProfile.ts').Rail,
      });

      if (eligibility.decision !== 'ALLOWED') {
          if (this.ownsTransaction) await this.client.query('ROLLBACK');
        return {
          success: false,
          financialTransactionId: '',
          operationId: command.operationId,
          created: false,
          eligibilityDecision: eligibility.decision,
          error: `Blocked: ${eligibility.decision} — ${eligibility.reason}`,
        };
      }

      const profile = eligibility.profile!;
      // Principal payment operations do not require a Konektag Legal Entity.
      // A Legal Entity may be supplied only by a distinct accounting/revenue context.
      const legalEntityId = command.legalEntityId;
      const corridorId = command.corridorId ?? profile.corridorId;
      const regulatoryProfileId = command.regulatoryProfileId ?? profile.id;
      // Provider/actor identity comes from the approved profile, never a caller
      // supplied actor. A regulated profile cannot finalize without its proof.
      if (command.regulatedActorId && command.regulatedActorId !== profile.regulatedActorId) {
        throw new Error('REGULATED_ACTOR_CONTEXT_MISMATCH');
      }
      const regulatedActorId = profile.regulatedActorId ?? undefined;
      const executionRequired = Boolean(profile.regulatedActorId) || profile.evidenceRequired.length > 0;
      if (executionRequired && !command.regulatedExecutionRef?.trim()) {
        throw new Error('REGULATED_EXECUTION_REFERENCE_REQUIRED');
      }
      if (command.regulatedExecutionRef && !/^[A-Za-z0-9._:/-]{1,200}$/.test(command.regulatedExecutionRef)) {
        throw new Error('REGULATED_EXECUTION_REFERENCE_INVALID');
      }
      const valueDate = command.valueDate ?? new Date().toISOString().slice(0, 10);
      if ((command.counterpartyEntityId || command.positionId) && (!command.counterpartyEntityId || !command.positionId)) {
        throw new Error('Cross-border operation requires counterparty_entity_id and position_id');
      }

      const companyAccount = (accountCode: string) => /^(4|6|7)/.test(accountCode)
        && !['2000','8000'].includes(accountCode);
      if (!legalEntityId && command.entries.some(entry => companyAccount(entry.accountCode))) {
        throw new Error('KONEKTAG_ACCOUNTING_OWNER_REQUIRED');
      }
      if (legalEntityId) {
        const {rows:[owner]}=await this.client.query(
          `SELECT status FROM konektag.legal_entities WHERE id=$1 AND deleted_at IS NULL`, [legalEntityId]);
        if (!owner || owner.status!=='APPROVED') throw new Error('KONEKTAG_ACCOUNTING_OWNER_NOT_APPROVED');
      }

      // 4. Create transaction with all V3 dimensions
      const txId = await this.repo.createTransaction({
        idempotencyKey: command.idempotencyKey,
        operationId: command.operationId,
        operation: command.operation,
        legalEntityId,
        counterpartyEntityId: command.counterpartyEntityId,
        corridorId,
        regulatoryProfileId,
        regulatedActorId,
        regulatedExecutionRef: command.regulatedExecutionRef,
        positionId: command.positionId,
        klotId: command.klotId,
        sourceOperationId: command.sourceOperationId,
        currency: command.currency,
        valueDate,
        eligibilityDecision: 'ALLOWED',
        entries: command.entries,
        auditEvent: command.operation,
      });

      // Allocate only after the financial transaction has a durable UUID.
      if (command.klotId && command.klotQuantity) {
        const allocated = await this.repo.allocateKLot(command.klotId, command.klotQuantity, txId);
        if (!allocated) {
          throw new Error('KLot allocation failed: insufficient remaining quantity');
        }
      }

      // 5. Create all ledger entries with dimensions
      for (const entry of command.entries) {
        await this.repo.createLedgerEntry(txId, entry, {
          idempotencyKey: command.idempotencyKey,
          operationId: command.operationId,
          operation: command.operation,
          legalEntityId,
          counterpartyEntityId: command.counterpartyEntityId,
          corridorId,
          regulatoryProfileId,
          regulatedActorId,
          regulatedExecutionRef: command.regulatedExecutionRef,
          positionId: command.positionId,
          klotId: command.klotId,
          sourceOperationId: command.sourceOperationId,
          currency: command.currency,
          valueDate,
          eligibilityDecision: 'ALLOWED',
          entries: [],
          auditEvent: command.operation,
        });
      }

      // 6. Verify balance
      const balance = await this.repo.verifyBalance(txId);
      if (balance.debit !== balance.credit || balance.debit === 0) {
        throw new Error(`Unbalanced transaction: debit ${balance.debit} ≠ credit ${balance.credit}`);
      }

      // 7. Accounting projection is entity-owned. Do not project the payment
      // principal to Frappe when no Konektag revenue/fee Legal Entity exists.
      if (legalEntityId) {
        await this.repo.createOutboxEvent(txId, {
          operation: command.operation,
          operationId: command.operationId,
          transactionType: command.operation,
          businessReference: command.operationId,
          currency: command.currency,
          entries: command.entries.map(e => ({
            accountCode: e.accountCode,
            side: e.side,
            amount: e.amount.toString(),
          })),
        });
      }

      // 8. Complete transaction
      await this.repo.completeTransaction(txId);

      // 9. Audit log
      await this.repo.createAuditLog(txId, command.operation, {
        operationId: command.operationId,
        profileCode: profile.profileCode,
        legalEntityId: legalEntityId ?? null,
      });

      if (this.ownsTransaction) await this.client.query('COMMIT');

      return {
        success: true,
        financialTransactionId: txId,
        operationId: command.operationId,
        created: true,
        eligibilityDecision: 'ALLOWED',
      };

    } catch (err) {
      if (this.ownsTransaction) {
        try { await this.client.query('ROLLBACK'); } catch { /* already rolled back */ }
      }
      return {
        success: false,
        financialTransactionId: '',
        operationId: command.operationId,
        created: false,
        error: (err as Error).message,
      };
    }
  }

  async executeReversal(command: V3OperationCommand): Promise<V3OperationResult> {
    if (!command.sourceOperationId) {
      return {
        success: false,
        financialTransactionId: '',
        operationId: command.operationId,
        created: false,
        error: 'Reversal requires source_operation_id',
      };
    }
    if (!command.reversalReason) {
      return {
        success: false,
        financialTransactionId: '',
        operationId: command.operationId,
        created: false,
        error: 'Reversal requires reversal_reason',
      };
    }

    return this.execute(command);
  }
}
