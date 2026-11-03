import { resolveMerchantCommission } from './pay/merchant-commission-service.ts';
import pool from '../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';
import { accountingService } from './accounting-service.ts';
import { MerchantSettlementRepository, type MerchantSettlementFilters } from '../../infrastructure/repositories/merchant-settlement-repository.ts';
import { resolveLegalEntityCurrency, resolveMerchantOperationCurrency } from './operation-currency-service.ts';

async function insertProjectionEvent(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  settlementId: string,
  eventType: 'MERCHANT_SETTLEMENT_PREPARED' | 'MERCHANT_SETTLEMENT_APPROVED' | 'MERCHANT_SETTLEMENT_BANK_PENDING' | 'MERCHANT_SETTLEMENT_PROOF_AWAITING_VERIFICATION' | 'MERCHANT_SETTLEMENT_PROOF_REJECTED' | 'MERCHANT_SETTLEMENT_SETTLED',
  payload: Record<string, unknown>,
): Promise<void> {
  const eventId = crypto.randomUUID();
  await client.query(
    `INSERT INTO konektag.outbox_events
     (id, correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
     VALUES ($1, $2, 'MerchantSettlement', $3, $4, 1, $5)`,
    [eventId, crypto.randomUUID(), settlementId, eventType, JSON.stringify(payload)],
  );
}

async function settlementRegulatoryProfile(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  settlementId: string,
): Promise<string> {
  const { rows: [facts] } = await client.query(
    `SELECT MIN(ft.regulatory_profile_id::text) AS regulatory_profile_id,
            COUNT(DISTINCT ft.regulatory_profile_id) AS profile_count,
            COUNT(*) FILTER (WHERE ft.regulatory_profile_id IS NULL) AS missing_count
     FROM konektag.merchant_settlement_sales mss
     JOIN konektag.merchant_sales ms ON ms.id = mss.sale_id
     LEFT JOIN LATERAL (
       SELECT legacy.regulatory_profile_id
       FROM konektag.financial_transactions legacy WHERE legacy.id = ms.transaction_id
       UNION ALL
       SELECT rp.id FROM konektag.merchant_settlements st
       JOIN konektag.merchant_profiles mp ON mp.id = st.merchant_profile_id
       JOIN konektag.legal_entities le ON le.id = st.legal_entity_id
       JOIN LATERAL (
         SELECT id FROM konektag.regulatory_profiles
         WHERE authorized_operation = 'settlement'
           AND country_of_origin = mp.country AND country_of_destination = le.country_code
           AND status = 'APPROVED' AND deleted_at IS NULL
         ORDER BY valid_from DESC, created_at DESC, id DESC LIMIT 1
       ) rp ON true
       WHERE st.id = mss.settlement_id AND ms.k_operation_id IS NOT NULL AND ms.transaction_id IS NULL
     ) ft ON true
     WHERE mss.settlement_id = $1`,
    [settlementId],
  );
  if (!facts || Number(facts.profile_count) !== 1 || Number(facts.missing_count) !== 0) {
    throw new Error('SETTLEMENT_REGULATORY_PROFILE_REQUIRED');
  }
  return facts.regulatory_profile_id;
}

function merchantLifecyclePayload(
  settlement: any,
  regulatoryProfileId: string,
  actorId: string,
  sourceReference: string,
): Record<string, unknown> {
  const valueDate = normalizeValueDate(settlement.period_end);
  return {
    Amount: Number(settlement.net_amount),
    Currency: settlement.currency,
    ValueDate: valueDate,
    SourceReference: sourceReference,
    MerchantSettlementBatchId: settlement.id,
    MerchantId: settlement.merchant_profile_id,
    LegalEntity: settlement.legal_entity_id,
    RegulatoryProfileId: regulatoryProfileId,
    ActorId: actorId,
  };
}

function normalizeValueDate(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('SETTLEMENT_VALUE_DATE_INVALID');
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('SETTLEMENT_VALUE_DATE_INVALID');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('SETTLEMENT_VALUE_DATE_INVALID');
  }
  return value;
}

export interface SettlementInput {
  settlementRef: string;
  legalEntityId: string;
  merchantProfileId: string;
  merchantSaleIds: string[];
  grossAmount: number;
  netAmount: number;
  currency: string;
  rail: string;
  railProofRef: string;
  railProofUrl: string;
  valueDate: string;
  preparedBy: string;
  notes?: string;
}

export interface SettlementResult {
  settlementId: string;
  status: 'PREPARED' | 'APPROVED' | 'BANK_PENDING' | 'SETTLED' | 'REJECTED';
  needsApproval: boolean;
}

export interface SettlementEvidenceInput {
  settlementId: string;
  confirmedBy: string;
  evidenceType: 'bank_statement' | 'bank_transfer' | 'psp_confirm' | 'cobac_declaration' | 'other';
  evidenceUrl: string;
  contentHash: string;
}

/** Runtime capability: plain request payloads cannot satisfy this type or its private marker. */
export class TrustedSettlementEvidence {
  readonly #verified = true;
  private constructor(readonly input: SettlementEvidenceInput) {}
  static fromVerifiedServerSource(input: SettlementEvidenceInput): TrustedSettlementEvidence {
    if (!input.evidenceUrl.startsWith('https://') || !/^[a-f0-9]{64}$/i.test(input.contentHash)) {
      throw new Error('SETTLEMENT_PROVIDER_EVIDENCE_INVALID');
    }
    return new TrustedSettlementEvidence(input);
  }
  isVerified(): boolean { return this.#verified; }
}

export const settlementService = {

  async listSettlements(filters: MerchantSettlementFilters = {}) {
    return new MerchantSettlementRepository(pool).list(filters);
  },

  async getSettlement(settlementId: string) {
    return new MerchantSettlementRepository(pool).findById(settlementId);
  },

  async projectManualPayoutEvent(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, input: { settlement: any; actorId: string; eventType: 'MERCHANT_SETTLEMENT_BANK_PENDING' | 'MERCHANT_SETTLEMENT_PROOF_AWAITING_VERIFICATION' | 'MERCHANT_SETTLEMENT_PROOF_REJECTED'; sourceReference: string }) {
    normalizeValueDate(input.settlement.period_end);
    const regulatoryProfileId = await settlementRegulatoryProfile(client, input.settlement.id);
    await insertProjectionEvent(client, input.settlement.id, input.eventType,
      merchantLifecyclePayload(input.settlement, regulatoryProfileId, input.actorId, input.sourceReference));
  },

  /** Prepare un settlement — reste en PREPARED jusqu'a approbation maker-checker */
  async prepareSettlement(input: SettlementInput): Promise<SettlementResult> {
    const valueDate = normalizeValueDate(input.valueDate);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entityContext = await resolveLegalEntityCurrency(client, input.legalEntityId, input.currency);
      const merchantContext = await resolveMerchantOperationCurrency(client, input.merchantProfileId, input.currency);
      // Settlement owns the Konektag Legal Entity context. The merchant payment
      // itself is intentionally independent from any Legal Entity assignment.
      if (merchantContext.currency !== entityContext.currency) {
        throw new Error('SETTLEMENT_CONTEXT_MISMATCH');
      }
      const { rows: reconciliationBlocks } = await client.query(
        `SELECT id FROM konektag.daily_reconciliations
         WHERE blocks_settlement = true AND (legal_entity_id = $1 OR legal_entity_id IS NULL)
           AND status IN ('MISMATCH', 'INVESTIGATING') LIMIT 1`,
        [input.legalEntityId],
      );
      if (reconciliationBlocks[0]) throw new Error('SETTLEMENT_BLOCKED_BY_RECONCILIATION');
      if (input.merchantSaleIds.length === 0) throw new Error('At least one sale is required');
      let grossAmount = 0;
      let netAmount = 0;
      let taxAmount = 0;
      let commissionAmount = 0;
      // Exact per-sale bonus decimals; summed and rounded by PostgreSQL NUMERIC, never by JS Number.
      const saleBonuses: string[] = [];
      const saleCommissions: string[] = [];
      const commissionFacts: Array<{saleId:string; consumptionId:string; ruleId:string; bps:number; basis:string; amount:string}> = [];
      const compensationAt = new Date();
      // Lock all sales so they cannot be prepared by two settlements concurrently.
      for (const saleId of input.merchantSaleIds) {
        const { rows: [sale] } = await client.query(
          `SELECT s.*, EXISTS(SELECT 1 FROM konektag.merchant_settlement_sales mss WHERE mss.sale_id = s.id) AS linked
           FROM konektag.merchant_sales s WHERE s.id = $1 AND s.deleted_at IS NULL FOR UPDATE`,
          [saleId],
        );
        if (!sale) throw new Error(`Vente ${saleId} introuvable`);
        if (sale.status !== 'CREATED' || sale.linked) {
          throw new Error(`Vente ${saleId} deja reglee (${sale.status})`);
        }
        if (sale.merchant_profile_id !== input.merchantProfileId || sale.currency !== input.currency) {
          throw new Error(`Vente ${saleId} incompatible avec le settlement`);
        }
        // Commission is determined here, never while the payer spends K.
        const {rows: consumptions} = await client.query(
          `SELECT pc.*, COALESCE((SELECT sum(quantity) FROM konektag.points_merchant_refunds WHERE consumption_id=pc.id),0) AS refunded_quantity
           FROM konektag.points_merchant_consumptions pc WHERE ($1::uuid IS NOT NULL AND monetary_transaction_id=$1)
             OR ($2::uuid IS NOT NULL AND k_operation_id=$2)`, [sale.transaction_id, sale.k_operation_id]);
        let remainingGross = Number(sale.gross_amount);
        for (const consumption of consumptions) {
          if (!['qr','payment_link'].includes(consumption.payment_rail)) continue;
          const quote = await resolveMerchantCommission(client, {
            paymentCountry: consumption.payment_country, rail: consumption.payment_rail,
            transactionAmountMinor: Number(consumption.transaction_amount_minor), at: compensationAt,
          });
          const {rows:[amounts]} = await client.query(
            `SELECT round($1::numeric*($2::numeric-$3::numeric)/$2::numeric,8)::text AS basis,
                    round($1::numeric*($2::numeric-$3::numeric)/$2::numeric*$4::numeric/10000,8)::text AS commission`,
            [consumption.transaction_amount_minor,consumption.quantity,consumption.refunded_quantity,quote.percentageBps]);
          remainingGross = Number(amounts.basis);
          saleCommissions.push(amounts.commission);
          commissionFacts.push({saleId,consumptionId:consumption.id,ruleId:quote.ruleId,bps:quote.percentageBps,basis:amounts.basis,amount:amounts.commission});
        }
        grossAmount += remainingGross;
        netAmount += remainingGross;
        // QR Pay / Link Pay bonus is earned in the sale currency and paid only through settlement.
        const { rows: [bonusFacts] } = await client.query(
          `SELECT (COALESCE(sum(b.amount-COALESCE(rr.reversed,0)) FILTER (WHERE b.status='earned'),0))::text AS bonus,
                  COUNT(*) FILTER (WHERE b.currency<>$2) AS currency_mismatch
           FROM konektag.points_merchant_consumptions pc
           LEFT JOIN konektag.merchant_points_bonuses b ON b.consumption_id=pc.id
           LEFT JOIN LATERAL (SELECT sum(r.bonus_reversal) AS reversed FROM konektag.points_merchant_refunds r WHERE r.consumption_id=pc.id) rr ON true
           WHERE (($1::uuid IS NOT NULL AND pc.monetary_transaction_id=$1)
             OR ($3::uuid IS NOT NULL AND pc.k_operation_id=$3)) AND pc.payment_rail IN ('qr','payment_link')`,
          [sale.transaction_id, sale.currency, sale.k_operation_id]);
        if (Number(bonusFacts?.currency_mismatch ?? 0) !== 0) throw new Error('SETTLEMENT_BONUS_CURRENCY_MISMATCH');
        const saleBonus = String(bonusFacts?.bonus ?? '0');
        if (saleBonus.startsWith('-')) throw new Error('SETTLEMENT_BONUS_NEGATIVE');
        saleBonuses.push(saleBonus);
        taxAmount += Number(sale.tax_amount ?? 0);
      }

      // MerchantSale gross is the commercial amount. QR/Link commission and +1% bonus are
      // settlement-only adjustments. Exact values are accumulated first and rounded once in
      // the sale currency's stored minor unit; no payer fee or pre-settlement deduction applies.
      const { rows: [compensation] } = await client.query(
        `SELECT round(COALESCE((SELECT sum(b::numeric) FROM unnest($1::text[]) b),0),0)::text AS bonus,
                round(COALESCE((SELECT sum(c::numeric) FROM unnest($2::text[]) c),0),0)::text AS commission,
                ($3::numeric
                  +round(COALESCE((SELECT sum(b::numeric) FROM unnest($1::text[]) b),0),0)
                  -round(COALESCE((SELECT sum(c::numeric) FROM unnest($2::text[]) c),0),0))::text AS net`,
        [saleBonuses, saleCommissions, String(grossAmount)]);
      const pointsBonusAmount = String(compensation.bonus);
      commissionAmount = Number(compensation.commission);
      const settlementNetAmount = String(compensation.net);
      netAmount = Number(settlementNetAmount);

      // Empecher l'auto-approbation : le prepareur ne peut pas approuver
      // Cette contrainte est verifiee par le backoffice permission service en amont

      const { rows: [settlement] } = await client.query(
        `INSERT INTO konektag.merchant_settlements (settlement_ref, merchant_profile_id, legal_entity_id,
           period_start, period_end, gross_amount, net_amount, tax_amount, commission_amount, points_bonus_amount, currency,
           status, prepared_by, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PREPARED', $12, $13)
          RETURNING id`,
         [input.settlementRef, input.merchantProfileId, input.legalEntityId, valueDate, valueDate,
         grossAmount, settlementNetAmount, taxAmount, commissionAmount, pointsBonusAmount, input.currency, input.preparedBy, input.notes ?? null],
      );
      for (const fact of commissionFacts) {
        await client.query(`INSERT INTO konektag.merchant_settlement_commissions
          (settlement_id,sale_id,consumption_id,rule_id,percentage_bps,basis_amount,amount_exact,currency)
          VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8)`,
          [settlement.id,fact.saleId,fact.consumptionId,fact.ruleId,fact.bps,fact.basis,fact.amount,input.currency]);
        if (Number(fact.amount)>0) {
          const {rows:[mapping]}=await client.query(`SELECT legal_entity_id FROM konektag.merchant_accounting_mappings
            WHERE merchant_profile_id=$1 AND revenue_type='merchant_commission' AND currency=$2 AND active`,[input.merchantProfileId,input.currency]);
          if (mapping && mapping.legal_entity_id!==input.legalEntityId) throw new Error('SETTLEMENT_REVENUE_OWNER_MISMATCH');
          await client.query(`INSERT INTO konektag.konektag_revenue_attributions
            (source_type,source_id,merchant_profile_id,revenue_type,legal_entity_id,currency,amount_exact,rule_id)
            VALUES('merchant_settlement_sale',$1,$2,'merchant_commission',$3,$4,$5::numeric,$6)`,
            [fact.saleId,input.merchantProfileId,input.legalEntityId,input.currency,fact.amount,fact.ruleId]);
        }
      }
      for (const saleId of input.merchantSaleIds) {
        await client.query(`INSERT INTO konektag.merchant_settlement_sales (settlement_id, sale_id) VALUES ($1, $2)`, [settlement.id, saleId]);
      }

      // Créer l'action admin pour le settlement — trace maker-checker
      await client.query(
        `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
         VALUES ($1, 'MERCHANT_SETTLEMENT_PREPARED', 'merchant', $2, $3, $4)`,
        [input.preparedBy, settlement.id,
         `Reglement prepare: ${input.settlementRef}`,
         JSON.stringify({
           settlementRef: input.settlementRef,
           rail: input.rail,
           railProofRef: input.railProofRef,
           valueDate: input.valueDate,
           grossAmount: input.grossAmount,
           netAmount: input.netAmount,
           saleIds: input.merchantSaleIds,
         })],
      );

      // Preserve the established internal event while adding the external projection event.
      await client.query(
        `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'MerchantSettlement', $2, 'SettlementPrepared', 1, $3)`,
        [crypto.randomUUID(), settlement.id, JSON.stringify({
          settlementRef: input.settlementRef,
          preparedBy: input.preparedBy,
          grossAmount,
          netAmount,
          rail: input.rail,
        })],
      );
      const regulatoryProfileId = await settlementRegulatoryProfile(client, settlement.id);
      await insertProjectionEvent(client, settlement.id, 'MERCHANT_SETTLEMENT_PREPARED', merchantLifecyclePayload({
        id: settlement.id,
        settlement_ref: input.settlementRef,
        merchant_profile_id: input.merchantProfileId,
        legal_entity_id: input.legalEntityId,
        net_amount: netAmount,
        currency: input.currency,
         period_end: valueDate,
      }, regulatoryProfileId, input.preparedBy, input.railProofRef));

      await client.query('COMMIT');
      return {
        settlementId: settlement.id,
        status: 'PREPARED',
        needsApproval: true,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  /** Approuve un settlement — exige role approver + preuve de rail */
  async approveSettlement(
    settlementId: string,
    approverId: string,
    _railProofVerified: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [settlement] } = await client.query(
        `SELECT * FROM konektag.merchant_settlements WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [settlementId],
      );
      if (!settlement || settlement.status !== 'PREPARED') throw new Error('SETTLEMENT_NOT_PREPARED');
      if (settlement.points_bonus_review_required) throw new Error('SETTLEMENT_REFUND_REVIEW_REQUIRED');
      await resolveLegalEntityCurrency(client, settlement.legal_entity_id, settlement.currency);
      if (settlement.prepared_by === approverId) throw new Error('MAKER_CHECKER_VIOLATION: Le prepareur ne peut pas approuver son propre reglement.');
      const { rows } = await client.query(
        `UPDATE konektag.merchant_settlements SET status = 'APPROVED', approved_by = $1, version = version + 1, updated_at = now()
         WHERE id = $2 AND status = 'PREPARED' AND version = $3 RETURNING id`,
        [approverId, settlementId, settlement.version],
      );
      if (!rows[0]) throw new Error('SETTLEMENT_CONCURRENTLY_MODIFIED');
      await client.query(
        `INSERT INTO konektag.admin_approvals (entity_type, entity_id, approver_id, approval_role, decision)
         VALUES ('merchant_settlement', $1, $2, 'approver', 'APPROVED')`, [settlementId, approverId],
      );
      const regulatoryProfileId = await settlementRegulatoryProfile(client, settlementId);
      await insertProjectionEvent(client, settlementId, 'MERCHANT_SETTLEMENT_APPROVED',
        merchantLifecyclePayload(settlement, regulatoryProfileId, approverId, settlement.settlement_ref));
      await client.query('COMMIT');
      return { ok: true };
    } catch (error) {
      await client.query('ROLLBACK');
      return { ok: false, error: (error as Error).message };
    } finally { client.release(); }
  },

  async confirmSettlement(evidence: TrustedSettlementEvidence): Promise<{ ok: boolean; error?: string }> {
    if (!(evidence instanceof TrustedSettlementEvidence) || !evidence.isVerified()) {
      return { ok: false, error: 'SETTLEMENT_TRUSTED_EVIDENCE_REQUIRED' };
    }
    const input = evidence.input;
    if (!input.evidenceUrl.startsWith('https://')) return { ok: false, error: 'SETTLEMENT_EVIDENCE_URL_REQUIRED' };
    if (!/^[a-f0-9]{64}$/i.test(input.contentHash)) {
      return { ok: false, error: 'SETTLEMENT_TRUSTED_EVIDENCE_REQUIRED' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [settlement] } = await client.query(
        `SELECT * FROM konektag.merchant_settlements WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [input.settlementId],
      );
      if (!settlement || !['APPROVED', 'BANK_PENDING'].includes(settlement.status)) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'SETTLEMENT_NOT_APPROVED' };
      }
      if (settlement.points_bonus_review_required) throw new Error('SETTLEMENT_REFUND_REVIEW_REQUIRED');
      await resolveLegalEntityCurrency(client, settlement.legal_entity_id, settlement.currency);
      const { rows: [merchantParty] } = await client.query<{ id: string }>(
        `SELECT p.id FROM konektag.merchant_profiles mp
         JOIN konektag.users u ON u.id=mp.user_id AND u.deleted_at IS NULL
          JOIN konektag.parties p ON p.keycloak_id=u.keycloak_id AND p.party_type='merchant' AND p.is_active=true
         WHERE mp.id=$1 AND mp.deleted_at IS NULL`, [settlement.merchant_profile_id],
      );
      if (!merchantParty) throw new Error('MERCHANT_PARTY_REQUIRED');
      const regulatoryProfileId = await settlementRegulatoryProfile(client, input.settlementId);
      const { rows: [transactionFacts] } = await client.query<{ corridor_id: string; eligibility_decision: string }>(
        `SELECT MIN(ft.corridor_id) AS corridor_id, MIN(ft.eligibility_decision) AS eligibility_decision
         FROM konektag.merchant_settlement_sales mss
         JOIN konektag.merchant_sales ms ON ms.id=mss.sale_id
         JOIN konektag.financial_transactions ft ON ft.id=ms.transaction_id
         WHERE mss.settlement_id=$1`, [input.settlementId],
      );
      if (!transactionFacts?.corridor_id || !transactionFacts.eligibility_decision) throw new Error('SETTLEMENT_TRANSACTION_DIMENSIONS_REQUIRED');
      const { rows: [evidence] } = await client.query(
        `INSERT INTO konektag.settlement_evidence
         (settlement_id, evidence_type, evidence_url, content_hash, verified, verified_by, verified_at)
         VALUES ($1, $2, $3, $4, true, $5, now()) RETURNING id`,
        [input.settlementId, input.evidenceType, input.evidenceUrl, input.contentHash ?? null, input.confirmedBy],
      );
      if (!evidence) throw new Error('SETTLEMENT_EVIDENCE_NOT_STORED');
      const { rows: [pending] } = await client.query(
        `UPDATE konektag.merchant_settlements SET status = 'BANK_PENDING', version = version + 1, updated_at = now()
         WHERE id = $1 AND status = 'APPROVED' AND version = $2 RETURNING version`,
        [input.settlementId, settlement.version],
      );
      if (settlement.status === 'APPROVED' && !pending) throw new Error('SETTLEMENT_CONCURRENTLY_MODIFIED');

      const posted = await accountingService.postTransaction({
        idempotencyKey: `merchant-settlement:${input.settlementId}`,
        transactionType: 'settlement',
        businessReference: settlement.settlement_ref,
        currency: settlement.currency,
        entries: [
          { accountCode: '2000', partyId: merchantParty.id, side: 'debit', amount: Number(settlement.net_amount), description: `Merchant debt settlement ${settlement.settlement_ref}` },
          { accountCode: '1100', side: 'credit', amount: Number(settlement.net_amount), description: `Bank or PSP payment ${settlement.settlement_ref}` },
        ],
        metadata: {
          operationId: `SETTLEMENT-${input.settlementId}`,
          legalEntityId: settlement.legal_entity_id,
          corridorId: transactionFacts.corridor_id,
          regulatoryProfileId,
          valueDate: new Date().toISOString().slice(0, 10),
          regulatedExecutionRef: input.evidenceUrl,
          eligibilityDecision: transactionFacts.eligibility_decision,
        },
      }, client);
      if (!posted.success) throw new Error(posted.error || 'SETTLEMENT_ACCOUNTING_FAILED');
      const { rows } = await client.query(
        `UPDATE konektag.merchant_settlements SET status = 'SETTLED', confirmed_by = $1, bank_proof_url = $2,
         settlement_date = CURRENT_DATE, version = version + 1, updated_at = now()
         WHERE id = $3 AND status = 'BANK_PENDING' RETURNING id`,
        [input.confirmedBy, input.evidenceUrl, input.settlementId],
      );
      if (!rows[0]) throw new Error('SETTLEMENT_CONFIRMATION_FAILED');
      await client.query(
        `UPDATE konektag.merchant_sales SET status = 'SETTLED', updated_at = now()
         WHERE id IN (SELECT sale_id FROM konektag.merchant_settlement_sales WHERE settlement_id = $1)`,
        [input.settlementId],
      );
      await insertProjectionEvent(client, input.settlementId, 'MERCHANT_SETTLEMENT_SETTLED', {
        ...merchantLifecyclePayload(settlement, regulatoryProfileId, input.confirmedBy, settlement.settlement_ref),
        PaymentRailReference: input.evidenceUrl,
        SettlementEvidence: input.evidenceUrl,
        ReconciliationResult: 'Matched',
      });
      await client.query('COMMIT');
      return { ok: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return { ok: false, error: (error as Error).message };
    } finally { client.release(); }
  },
};
