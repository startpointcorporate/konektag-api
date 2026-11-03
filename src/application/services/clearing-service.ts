import pool from '../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';
import { accountingService } from './accounting-service.ts';
import { ClearingRepository } from '../../infrastructure/repositories/clearing-repository.ts';
import type { ClearingBatch as ClearingBatchDto } from '../../infrastructure/repositories/clearing-repository.ts';
import { resolveLegalEntityCurrency } from './operation-currency-service.ts';

async function insertProjectionEvent(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  batchId: string,
  eventType: 'CLEARING_FROZEN' | 'CLEARING_APPROVED' | 'CLEARING_SETTLED',
  payload: Record<string, unknown>,
): Promise<void> {
  const eventId = crypto.randomUUID();
  await client.query(
    `INSERT INTO konektag.outbox_events
     (id, correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
     VALUES ($1, $2, 'ClearingBatch', $3, $4, 1, $5)`,
    [eventId, crypto.randomUUID(), batchId, eventType, JSON.stringify(payload)],
  );
}

async function clearingLifecyclePayload(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  batch: any,
  actorId: string,
  sourceReference: string,
): Promise<Record<string, unknown>> {
  const { rows: [facts] } = await client.query(
    `SELECT COALESCE(SUM(CASE
              WHEN (ip.direction = 'A_TO_B' AND ip.legal_entity_b_id = $2)
                OR (ip.direction = 'B_TO_A' AND ip.legal_entity_a_id = $2)
              THEN ABS(cbp.amount) ELSE 0 END), 0) AS gross_receivable,
            COALESCE(SUM(CASE
              WHEN (ip.direction = 'A_TO_B' AND ip.legal_entity_a_id = $2)
                OR (ip.direction = 'B_TO_A' AND ip.legal_entity_b_id = $2)
              THEN ABS(cbp.amount) ELSE 0 END), 0) AS gross_payable,
            MIN(ft.regulatory_profile_id::text) AS regulatory_profile_id,
            COUNT(DISTINCT ft.regulatory_profile_id) AS profile_count,
            COUNT(*) FILTER (WHERE ft.regulatory_profile_id IS NULL) AS missing_profile_count,
            MIN(ft.corridor_id) AS corridor,
            COUNT(DISTINCT ft.corridor_id) AS corridor_count,
            COUNT(*) FILTER (WHERE ft.corridor_id IS NULL) AS missing_corridor_count
     FROM konektag.clearing_batch_positions cbp
     JOIN konektag.intercompany_positions ip ON ip.id = cbp.position_id
     LEFT JOIN konektag.merchant_sales ms ON ms.id = ip.source_sale_id
     LEFT JOIN LATERAL (
       SELECT candidate.regulatory_profile_id, candidate.corridor_id
       FROM konektag.financial_transactions candidate
       WHERE candidate.position_id = ip.id OR candidate.id = ms.transaction_id
       ORDER BY (candidate.position_id = ip.id) DESC
       LIMIT 1
     ) ft ON true
     WHERE cbp.clearing_batch_id = $1`,
    [batch.id, batch.legal_entity_id],
  );
  if (!facts || Number(facts.profile_count) !== 1 || Number(facts.missing_profile_count) !== 0) {
    throw new Error('CLEARING_REGULATORY_PROFILE_REQUIRED');
  }
  if (Number(facts.corridor_count) !== 1 || Number(facts.missing_corridor_count) !== 0) {
    throw new Error('CLEARING_CORRIDOR_REQUIRED');
  }
  const receivable = Number(facts.gross_receivable);
  const payable = Number(facts.gross_payable);
  const net = receivable - payable;
  const nettingRequested = Boolean(batch.netting_allowed);
  const amount = nettingRequested ? Math.abs(net) : receivable + payable;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('CLEARING_NON_ZERO_AMOUNT_REQUIRED');
  return {
    Amount: amount,
    Currency: batch.currency,
    ValueDate: String(batch.period_end).slice(0, 10),
    SourceReference: sourceReference,
    ClearingBatchId: batch.id,
    LegalEntity: batch.legal_entity_id,
    CounterpartyEntity: batch.counterparty_entity_id,
    RegulatoryProfileId: facts.regulatory_profile_id,
    SettlementProfileId: batch.b2b_profile_id,
    PeriodKey: `${String(batch.period_start).slice(0, 10)}/${String(batch.period_end).slice(0, 10)}`,
    Corridor: facts.corridor,
    ActorId: actorId,
    GrossReceivableAmount: receivable,
    GrossPayableAmount: payable,
    NetReportingAmount: net,
    NettingRequested: nettingRequested,
  };
}

export interface FreezeBatchCommand {
  periodStart: string;
  periodEnd: string;
  legalEntityId: string;
  counterpartyEntityId: string;
  currency: string;
  b2bProfileId: string;
  initiatedBy: string;
}

export interface ApproveBatchCommand {
  batchId: string;
  approverId: string;
  remarks?: string;
}

export interface SettleBatchCommand {
  batchId: string;
  bankProofUrl: string;
  settledBy: string;
  fxRate?: string;
  cobacJustificationUrl?: string;
  declarationRef?: string;
}

export interface ClearingBatch {
  id: string;
  batchRef: string;
  periodStart: string;
  periodEnd: string;
  legalEntityId: string;
  status: 'OPEN' | 'FROZEN' | 'APPROVED' | 'SETTLED' | 'CANCELLED';
  financeAApprovedBy: string | null;
  financeBApprovedBy: string | null;
  complianceApprovedBy: string | null;
  bankProofUrl: string | null;
  settlementDate: string | null;
  version: number;
  positions?: Array<{
    positionId: string;
    legalEntityAId: string;
    legalEntityBId: string;
    direction: 'A_TO_B' | 'B_TO_A';
    amount: number;
    currency: string;
  }>;
  initiatedBy?: string | null;
}

interface SettlementBatchRow {
  id: string; status: string; source_currency: string; target_currency: string;
  fx_evidence_id: string | null; legal_entity_id: string; counterparty_entity_id: string;
  b2b_profile_id: string; batch_ref: string; currency: string; net_amount: string | null;
  gross_amount: string | null; version: number;
  fx_source_currency: string | null; fx_target_currency: string | null; fx_rate: string | number | null;
  fx_evidence_ref: string | null; fx_rate_source: string | null; fx_valued_at: string | Date | null;
  fx_recorded_by: string | null;
  profile_settlement_currency: string;
}

export const clearingService = {
  async listBatches(filters: { legalEntityId?: string; status?: string; limit?: number } = {}) {
    return new ClearingRepository(pool).list(filters);
  },

  async freezeBatch(command: FreezeBatchCommand): Promise<ClearingBatch> {
    // The pair, period and currency identify one clearing calculation. A retry
    // must resolve to the same batch, never create a second set of positions.
    const batchRef = `CLR-${command.legalEntityId}-${command.counterpartyEntityId}-${command.currency}-${command.periodStart}-${command.periodEnd}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await resolveLegalEntityCurrency(client, command.legalEntityId);
      await resolveLegalEntityCurrency(client, command.counterpartyEntityId);
      const { rows: reconciliationBlocks } = await client.query(
        `SELECT id FROM konektag.daily_reconciliations
         WHERE blocks_clearing = true AND (legal_entity_id IN ($1, $2) OR legal_entity_id IS NULL)
           AND status IN ('MISMATCH', 'INVESTIGATING') LIMIT 1`,
        [command.legalEntityId, command.counterpartyEntityId],
      );
      if (reconciliationBlocks[0]) throw new Error('CLEARING_BLOCKED_BY_RECONCILIATION');

      const existing = await client.query(
        `SELECT id, status FROM konektag.clearing_batches WHERE batch_ref = $1`,
        [batchRef],
      );

      if (existing.rows.length > 0) {
        const { rows: [batch] } = await client.query(`SELECT * FROM konektag.clearing_batches WHERE id = $1`, [existing.rows[0].id]);
        await client.query('COMMIT');
        return batch;
      }

      const { rows: [profile] } = await client.query(
        `SELECT id, netting_allowed, legal_entity_a_id, legal_entity_b_id, settlement_currency
         FROM konektag.b2b_settlement_profiles
          WHERE id = $1 AND status = 'APPROVED' AND deleted_at IS NULL FOR UPDATE`, [command.b2bProfileId],
      );
      if (!profile) throw new Error('B2B settlement profile is not approved');
      const pairMatches = (profile.legal_entity_a_id === command.legalEntityId && profile.legal_entity_b_id === command.counterpartyEntityId)
        || (profile.legal_entity_b_id === command.legalEntityId && profile.legal_entity_a_id === command.counterpartyEntityId);
      if (!pairMatches) throw new Error('CLEARING_PROFILE_ENTITY_MISMATCH');
      if (String(profile.settlement_currency).toUpperCase() !== command.currency.toUpperCase()) {
        throw new Error('CLEARING_PROFILE_CURRENCY_MISMATCH');
      }
      const { rows: [batch] } = await client.query(
        `INSERT INTO konektag.clearing_batches
          (batch_ref, period_start, period_end, legal_entity_id, counterparty_entity_id, b2b_profile_id, currency, netting_allowed, status, initiated_by, version)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'FROZEN', $9, 1)
          RETURNING *`,
        [batchRef, command.periodStart, command.periodEnd, command.legalEntityId, command.counterpartyEntityId, command.b2bProfileId, command.currency, profile.netting_allowed, command.initiatedBy],
      );
      const { rows: positions } = await client.query(
        `SELECT id, legal_entity_a_id, legal_entity_b_id, direction, amount, currency FROM konektag.intercompany_positions
         WHERE status = 'OPEN' AND currency = $1 AND value_date BETWEEN $2 AND $3
           AND ((legal_entity_a_id = $4 AND legal_entity_b_id = $5) OR (legal_entity_a_id = $5 AND legal_entity_b_id = $4))
         FOR UPDATE`, [command.currency, command.periodStart, command.periodEnd, command.legalEntityId, command.counterpartyEntityId],
      );
      for (const position of positions) {
        await client.query(`INSERT INTO konektag.clearing_batch_positions (clearing_batch_id, position_id, amount, currency) VALUES ($1, $2, $3, $4)`, [batch.id, position.id, position.amount, position.currency]);
      }
      const totals = positions.reduce((result, position) => {
        const amount = Math.abs(Number(position.amount));
        const legalEntityIsCreditor = (position.direction === 'A_TO_B' && position.legal_entity_b_id === command.legalEntityId)
          || (position.direction === 'B_TO_A' && position.legal_entity_a_id === command.legalEntityId);
        if (legalEntityIsCreditor) result.receivable += amount;
        else result.payable += amount;
        return result;
      }, { receivable: 0, payable: 0 });
      const grossAmount = totals.receivable + totals.payable;
      const settlementAmount = profile.netting_allowed ? Math.abs(totals.receivable - totals.payable) : null;
      await client.query(
        `UPDATE konektag.intercompany_positions SET status = 'INCLUDED_IN_BATCH', clearing_batch_id = $1
         WHERE id = ANY($2::uuid[])`, [batch.id, positions.map(position => position.id)],
      );
      await client.query(
        `UPDATE konektag.clearing_batches SET gross_amount = $1, net_amount = $2,
         position_count = $3 WHERE id = $4`, [grossAmount, settlementAmount, positions.length, batch.id],
      );

      await insertProjectionEvent(client, batch.id, 'CLEARING_FROZEN', await clearingLifecyclePayload(client, {
        ...batch,
        batch_ref: batchRef,
        legal_entity_id: command.legalEntityId,
        counterparty_entity_id: command.counterpartyEntityId,
        b2b_profile_id: command.b2bProfileId,
        period_start: command.periodStart,
        period_end: command.periodEnd,
        currency: command.currency,
        netting_allowed: profile.netting_allowed,
      }, command.initiatedBy, batchRef));

      await client.query('COMMIT');
      return batch;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async approveBatch(command: ApproveBatchCommand): Promise<ClearingBatch> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [batch] } = await client.query(
        `SELECT * FROM konektag.clearing_batches WHERE id = $1 FOR UPDATE`,
        [command.batchId],
      );

      if (!batch) throw new Error('Clearing batch not found');
      if (batch.status !== 'FROZEN') throw new Error(`Batch is ${batch.status}, expected FROZEN`);
      const { rows: [profile] } = await client.query(
        `SELECT settlement_currency FROM konektag.b2b_settlement_profiles
         WHERE id = $1 AND status = 'APPROVED' AND deleted_at IS NULL`,
        [batch.b2b_profile_id],
      );
      if (!profile || String(profile.settlement_currency).toUpperCase() !== String(batch.currency).toUpperCase()) {
        throw new Error('CLEARING_PROFILE_CURRENCY_MISMATCH');
      }
      if (batch.initiated_by === command.approverId) throw new Error('CLEARING_SELF_APPROVAL_FORBIDDEN');
      const { rows: [approver] } = await client.query(
        `SELECT u.role, u.country, le.country_code FROM konektag.users u
         JOIN konektag.legal_entities le ON le.id = $2 AND le.deleted_at IS NULL
         WHERE u.id = $1 AND u.deleted_at IS NULL`, [command.approverId, batch.legal_entity_id],
      );
      if (!approver) throw new Error('CLEARING_APPROVER_NOT_FOUND');
      if (approver.role !== 'compliance' && approver.country !== approver.country_code) {
        throw new Error('CLEARING_LEGAL_ENTITY_SCOPE_FORBIDDEN');
      }
      const approverRole = approver.role === 'compliance' ? 'compliance'
        : approver.role === 'finance_groupe' || approver.role === 'admin'
          ? (approver.country_code === 'FR' ? 'finance_a' : 'finance_b') : null;
      if (!approverRole) throw new Error('CLEARING_APPROVER_ROLE_FORBIDDEN');

      const updates: string[] = [];
      const values: any[] = [];
      let paramIdx = 1;

      if (approverRole === 'finance_a' && !batch.finance_a_approved_by) {
        updates.push(`finance_a_approved_by = $${paramIdx++}`);
        values.push(command.approverId);
      } else if (approverRole === 'finance_b' && !batch.finance_b_approved_by) {
        updates.push(`finance_b_approved_by = $${paramIdx++}`);
        values.push(command.approverId);
      } else if (approverRole === 'compliance' && !batch.compliance_approved_by) {
        updates.push(`compliance_approved_by = $${paramIdx++}`);
        values.push(command.approverId);
      } else {
        await client.query('ROLLBACK');
        throw new Error(`Role ${approverRole} already approved or invalid`);
      }

      updates.push(`version = version + 1`);
      values.push(command.batchId);

      const { rows: [updated] } = await client.query(
        `UPDATE konektag.clearing_batches
         SET ${updates.join(', ')}
         WHERE id = $${paramIdx}
         RETURNING *`,
        values,
      );

      await client.query(
        `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
         VALUES ($1, 'CLEARING_APPROVED', 'clearing_batch', $2, $3, $4)`,
        [command.approverId, command.batchId, command.remarks ?? null, JSON.stringify({ approverRole, legalEntityId: batch.legal_entity_id })],
      );

      if (updated.finance_a_approved_by && updated.finance_b_approved_by && updated.compliance_approved_by) {
        await client.query(
          `UPDATE konektag.clearing_batches SET status = 'APPROVED' WHERE id = $1`,
          [command.batchId],
        );
        updated.status = 'APPROVED';
        await insertProjectionEvent(client, command.batchId, 'CLEARING_APPROVED',
          await clearingLifecyclePayload(client, updated, command.approverId, updated.batch_ref));
      }

      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async markSettled(command: SettleBatchCommand): Promise<ClearingBatch> {
    if (!command.bankProofUrl || !command.bankProofUrl.startsWith('https://')) {
      throw new Error('bankProofUrl must be a valid HTTPS URL');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [batch] } = await client.query<SettlementBatchRow>(
        `SELECT cb.*, source.base_currency AS source_currency, target.base_currency AS target_currency,
                fx.id AS fx_evidence_id, fx.source_currency AS fx_source_currency,
                fx.target_currency AS fx_target_currency, fx.rate AS fx_rate,
                fx.evidence_ref AS fx_evidence_ref, fx.rate_source AS fx_rate_source,
                 fx.valued_at AS fx_valued_at, fx.recorded_by AS fx_recorded_by,
                 profile.settlement_currency AS profile_settlement_currency
         FROM konektag.clearing_batches cb
         JOIN konektag.legal_entities source ON source.id = cb.legal_entity_id
         JOIN konektag.legal_entities target ON target.id = cb.counterparty_entity_id
         JOIN konektag.b2b_settlement_profiles profile ON profile.id = cb.b2b_profile_id
         LEFT JOIN konektag.clearing_fx_evidence fx ON fx.clearing_batch_id = cb.id
         WHERE cb.id = $1 FOR UPDATE OF cb`,
        [command.batchId],
      );

      if (!batch) throw new Error('Clearing batch not found');
      if (batch.status !== 'APPROVED') throw new Error(`Batch is ${batch.status}, expected APPROVED`);
      await resolveLegalEntityCurrency(client, batch.legal_entity_id);
      await resolveLegalEntityCurrency(client, batch.counterparty_entity_id);
      if (String(batch.profile_settlement_currency).toUpperCase() !== String(batch.currency).toUpperCase()) {
        throw new Error('CLEARING_PROFILE_CURRENCY_MISMATCH');
      }
      if (batch.source_currency !== batch.target_currency && !batch.fx_evidence_id) {
        throw new Error('AUTHORITATIVE_FX_EVIDENCE_REQUIRED');
      }
      const fxRequired = batch.source_currency !== batch.target_currency;
      const fxRate = Number(batch.fx_rate);
      const validEvidence = batch.fx_source_currency === batch.source_currency
        && batch.fx_target_currency === batch.target_currency
        && Number.isFinite(fxRate) && fxRate > 0
        && Boolean(batch.fx_evidence_ref?.trim())
        && Boolean(batch.fx_rate_source?.trim())
        && Boolean(batch.fx_valued_at && !Number.isNaN(new Date(batch.fx_valued_at).getTime()))
        && Boolean(batch.fx_recorded_by);
      if (fxRequired && !validEvidence) throw new Error('AUTHORITATIVE_FX_EVIDENCE_INVALID');

      if (fxRequired) {
        await client.query(
          `UPDATE konektag.clearing_batches SET fx_rate = $2 WHERE id = $1`,
          [command.batchId, fxRate],
        );
      }

      const { rows: [entity] } = await client.query(
        `SELECT code, country_code FROM konektag.legal_entities WHERE id = $1 AND deleted_at IS NULL`,
        [batch.legal_entity_id],
      );

      if (entity?.country_code === 'CG' && !command.cobacJustificationUrl) {
        throw new Error('COBAC_REQUIRED: Reglement Congo exige justificatif COBAC/CEMAC (cobac_justification_url)');
      }

      const amount = Number(batch.net_amount ?? batch.gross_amount);
      if (amount <= 0) throw new Error('CLEARING_BATCH_HAS_NO_SETTLEMENT_AMOUNT');
      // Each company records its own external receivable or payable extinction.
      const dimensions = {
        operationId: `B2B-${command.batchId}`,
        counterpartyEntityId: batch.counterparty_entity_id,
        regulatoryProfileId: batch.b2b_profile_id,
        regulatedExecutionRef: fxRequired ? batch.fx_evidence_ref! : command.bankProofUrl,
        valueDate: new Date().toISOString().slice(0, 10),
      };
      const debitSide = await accountingService.postTransaction({
        idempotencyKey: `b2b-settlement:${command.batchId}:a`, transactionType: 'settlement', businessReference: batch.batch_ref,
        currency: batch.currency, entries: [
          { accountCode: '2100', side: 'debit', amount, description: `Intercompany payable extinction ${batch.batch_ref}` },
          { accountCode: '1100', side: 'credit', amount, description: `Bank settlement ${batch.batch_ref}` },
        ], metadata: { ...dimensions, legalEntityId: batch.legal_entity_id },
      }, client);
      const creditSide = await accountingService.postTransaction({
        idempotencyKey: `b2b-settlement:${command.batchId}:b`, transactionType: 'settlement', businessReference: batch.batch_ref,
        currency: batch.currency, entries: [
          { accountCode: '1100', side: 'debit', amount, description: `Bank settlement ${batch.batch_ref}` },
          { accountCode: '1200', side: 'credit', amount, description: `Intercompany receivable extinction ${batch.batch_ref}` },
        ], metadata: { ...dimensions, legalEntityId: batch.counterparty_entity_id, counterpartyEntityId: batch.legal_entity_id },
      }, client);
      if (!debitSide.success || !creditSide.success) throw new Error('B2B_EXTINCTION_ACCOUNTING_FAILED');

      const { rows: [updated] } = await client.query(
        `UPDATE konektag.clearing_batches
          SET status = 'SETTLED', bank_proof_url = $2, cobac_justification_url = $3, declaration_ref = $4, settlement_date = CURRENT_DATE,
              settled_by = $5, version = version + 1
          WHERE id = $1 AND status = 'APPROVED' AND version = $6
          RETURNING *`,
        [command.batchId, command.bankProofUrl, command.cobacJustificationUrl ?? null, command.declarationRef ?? null, command.settledBy, batch.version],
      );
      if (!updated) throw new Error('Clearing batch was modified concurrently');

      // Mark positions settled only once both accounting postings and the batch transition succeed.
      await client.query(
        `UPDATE konektag.intercompany_positions SET status = 'SETTLED' WHERE clearing_batch_id = $1`,
        [command.batchId],
      );

      await insertProjectionEvent(client, command.batchId, 'CLEARING_SETTLED', {
        ...await clearingLifecyclePayload(client, batch, command.settledBy, batch.batch_ref),
        SettlementEvidence: command.bankProofUrl,
      });

      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getBatch(batchId: string): Promise<ClearingBatchDto | null> {
    return new ClearingRepository(pool).findById(batchId);
  },

  async listBatchesByEntity(legalEntityId: string): Promise<ClearingBatchDto[]> {
    return new ClearingRepository(pool).list({ legalEntityId });
  },
};
