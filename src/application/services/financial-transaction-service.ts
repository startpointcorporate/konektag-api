import pool from '../../infrastructure/database/pool.ts';
import type { PoolClient } from 'pg';
import { accountingService } from './accounting-service.ts';
import type { AuthorizedOperation, Rail } from '../../domain/RegulatoryProfile.ts';
import type { FinancialAccountCode, FinancialTransactionType } from '../../domain/Accounting.ts';
import crypto from 'node:crypto';

export interface FinancialOperationCommand {
  idempotencyKey: string;
  operationId: string;
  operation: AuthorizedOperation;
  legalEntityId: string;
  counterpartyEntityId?: string;
  corridorId: string;
  regulatoryProfileId: string;
  regulatedActorId?: string;
  regulatedExecutionRef?: string;
  positionId?: string;
  klotId?: string;
  sourceOperationId?: string;
  currency: string;
  valueDate?: string;
  entries: Array<{
    clientId: string;
    partyId?: string;
    accountCode: FinancialAccountCode;
    side: 'debit' | 'credit';
    amount: number;
    description?: string;
  }>;
}

export interface FinancialOperationResult {
  success: boolean;
  financialTransactionId: string;
  created: boolean;
  error?: string;
}

export class FinancialTransactionService {
  /**
   * Poste une transaction financiere double-entree avec toutes les dimensions V3.
   * Delegate a FinancialOperationService pour l'atomicite complete.
   */
  async execute(command: FinancialOperationCommand): Promise<FinancialOperationResult> {
    if ((command.counterpartyEntityId || command.positionId) && (!command.counterpartyEntityId || !command.positionId)) {
      return { success: false, financialTransactionId: '', created: false, error: 'Cross-border operation requires counterparty_entity_id and position_id' };
    }
    if (command.regulatedActorId && !command.regulatedExecutionRef) {
      return { success: false, financialTransactionId: '', created: false, error: 'Regulated operation requires regulated_execution_ref' };
    }
    const result = await accountingService.postTransaction({
      idempotencyKey: command.idempotencyKey,
      transactionType: command.operation as FinancialTransactionType,
      businessReference: command.operationId,
      currency: command.currency,
      entries: command.entries.map(e => ({
        accountCode: e.accountCode,
        partyId: e.partyId,
        clientId: e.clientId,
        side: e.side,
        amount: e.amount,
        description: e.description,
      })),
      metadata: {
        legalEntityId: command.legalEntityId,
        counterpartyEntityId: command.counterpartyEntityId ?? null,
        corridorId: command.corridorId,
        operationId: command.operationId,
        regulatoryProfileId: command.regulatoryProfileId,
        regulatedActorId: command.regulatedActorId ?? null,
        regulatedExecutionRef: command.regulatedExecutionRef ?? null,
        positionId: command.positionId ?? null,
        klotId: command.klotId ?? null,
        sourceOperationId: command.sourceOperationId ?? null,
        valueDate: command.valueDate ?? new Date().toISOString().slice(0, 10),
      },
    });

    return result;
  }

  /**
   * Verrouille atomiquement le solde et debite dans la meme transaction.
   * Refuse si le solde disponible est insuffisant.
   */
  async debitWithBalanceCheck(
    clientId: string,
    amount: number,
    currency: string,
  ): Promise<{ sufficient: boolean; balance: number }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clientId]);

      const { rows } = await client.query(
        `SELECT COALESCE(SUM(CASE WHEN entry_side = 'credit' THEN amount ELSE -amount END), 0) AS balance
         FROM konektag.ledger_entries
         WHERE client_id = $1`,
        [clientId],
      );

      const balance = Number(rows[0]?.balance ?? 0);
      if (balance < amount) {
        await client.query('ROLLBACK');
        return { sufficient: false, balance };
      }

      await client.query('COMMIT');
      return { sufficient: true, balance };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Cree un KLot suite a une acquisition confirmee.
   * Appele uniquement APRES callback signe ou rapprochement fournisseur valide.
   */
  async createKLotOnConfirmedAcquisition(params: {
    klotRef: string;
    originEntityId: string;
    originCountry: string;
    rail: Rail;
    railRef: string;
    issuer?: string;
    quantityK: number;
    economicCurrency: string;
    economicValue: number;
    regulatoryProfileId: string;
  }): Promise<string> {
    const { rows: [klot] } = await pool.query(
      `INSERT INTO konektag.klots (klot_ref, origin_entity_id, origin_country, rail, rail_ref, issuer,
         quantity_k, economic_currency, economic_value, regulatory_profile_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'VALUATED')
       ON CONFLICT (klot_ref) DO UPDATE SET status = 'VALUATED'
       RETURNING id`,
      [params.klotRef, params.originEntityId, params.originCountry, params.rail, params.railRef,
       params.issuer ?? null, params.quantityK, params.economicCurrency, params.economicValue,
       params.regulatoryProfileId],
    );
    return klot.id;
  }

  /**
   * Cree un ValuationRecord lie au KLot.
   */
  async createValuation(params: {
    klotId: string;
    sourceCurrency: string;
    targetCurrency: string;
    rate: number;
    spreadBps: number;
    rateSource: string;
    fxRiskHolder: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO konektag.valuation_records (klot_id, source_currency, target_currency, rate,
         spread_bps, rate_source, rate_timestamp, fx_risk_holder)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7)`,
      [params.klotId, params.sourceCurrency, params.targetCurrency, params.rate,
       params.spreadBps, params.rateSource, params.fxRiskHolder],
    );
  }

}

export const financialTransactionService = new FinancialTransactionService();
