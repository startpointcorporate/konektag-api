import { createHash } from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';
import { settlementService, TrustedSettlementEvidence } from './settlement-service.ts';
import { ReconciliationService } from './reconciliation-service.ts';

export type MerchantPayoutRail = 'BANK' | 'PSP' | 'MOBILE_MONEY';

// V2 extension point only. V1 never registers or invokes an adapter.
export interface MerchantPayoutAdapter { rail: MerchantPayoutRail; submit(instruction: unknown): Promise<unknown>; }

// BANK_PSP accounts predate Settlement V1 and are stored as CARD. This keeps
// their existing constraint and data untouched while supporting bank payouts.
function accountMethodForRail(rail: MerchantPayoutRail): string { return rail === 'MOBILE_MONEY' ? 'MOBILE_MONEY' : 'CARD'; }
function normalizeValueDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('SETTLEMENT_VALUE_DATE_INVALID');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('SETTLEMENT_VALUE_DATE_INVALID');
  }
  return value;
}
function decodeDocument(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > 14_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('SETTLEMENT_PROOF_DOCUMENT_INVALID');
  const document = Buffer.from(value, 'base64');
  if (!document.length || document.length > 10_000_000) throw new Error('SETTLEMENT_PROOF_DOCUMENT_INVALID');
  return document;
}

async function loadConfiguration(client: any, settlement: any, rail: MerchantPayoutRail) {
  const { rows: [account] } = await client.query(
    `SELECT a.* FROM konektag.merchant_settlement_configurations c
     JOIN konektag.merchant_payment_provider_accounts a ON a.id=c.provider_account_id
     JOIN konektag.merchant_profiles mp ON mp.id=a.merchant_profile_id AND mp.deleted_at IS NULL
     WHERE c.merchant_profile_id=$1 FOR UPDATE`, [settlement.merchant_profile_id],
  );
  if (!account || account.merchant_profile_id !== settlement.merchant_profile_id || account.payment_method !== accountMethodForRail(rail) || !account.provider_account_reference) throw new Error('SETTLEMENT_PAYOUT_CONFIGURATION_INVALID');
  return account;
}

export const merchantSettlementPayoutService = {
  async startManualPayout(input: { settlementId: string; makerId: string; rail: MerchantPayoutRail }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [settlement] } = await client.query(`SELECT * FROM konektag.merchant_settlements WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [input.settlementId]);
      if (!settlement) throw new Error('SETTLEMENT_NOT_APPROVED');
      if (settlement.points_bonus_review_required) throw new Error('SETTLEMENT_REFUND_REVIEW_REQUIRED');
      const existing = await client.query(`SELECT * FROM konektag.merchant_settlement_payouts WHERE settlement_id=$1 FOR UPDATE`, [input.settlementId]);
      let payout = existing.rows[0];
      if (payout) {
        await client.query('COMMIT');
        return { payoutId: payout.id, status: payout.status, idempotent: true };
      }
      if (settlement.status !== 'APPROVED') throw new Error('SETTLEMENT_NOT_APPROVED');
      if (settlement.approved_by === input.makerId) throw new Error('MAKER_CHECKER_VIOLATION');
      const account = await loadConfiguration(client, settlement, input.rail);
      ({ rows: [payout] } = await client.query(
        `INSERT INTO konektag.merchant_settlement_payouts(settlement_id,provider_account_id,rail,payout_mode,idempotency_key,status,manual_workflow_status,submitted_at)
         VALUES($1,$2,$3,'MANUAL_ERP',$4,'CREATED','BANK_PENDING',now()) RETURNING *`,
        [input.settlementId, account.id, input.rail, `merchant-settlement-manual:${input.settlementId}`],
      ));
      await client.query(`UPDATE konektag.merchant_settlements SET status='BANK_PENDING',version=version+1,updated_at=now() WHERE id=$1 AND status='APPROVED'`, [input.settlementId]);
      await client.query(`INSERT INTO konektag.admin_actions(admin_id,action_type,target_type,target_id,reason,payload) VALUES($1,'MERCHANT_SETTLEMENT_PAYOUT_STARTED','merchant_settlement',$2,'Manual ERP payout started',$3)`, [input.makerId, input.settlementId, JSON.stringify({ payoutId: payout.id, rail: input.rail, beneficiary: account.provider_account_reference })]);
      await settlementService.projectManualPayoutEvent(client, { settlement, actorId: input.makerId, eventType: 'MERCHANT_SETTLEMENT_BANK_PENDING', sourceReference: payout.id });
      await client.query('COMMIT');
      return { payoutId: payout.id, status: 'BANK_PENDING', idempotent: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  },

  async submitManualProof(input: { payoutId: string; submittedBy: string; operatorReference: string; valueDate: string; amount: number; currency: string; filename: string; documentBase64: string }) {
    if (!input.operatorReference?.trim() || !Number.isSafeInteger(input.amount) || input.amount <= 0 || !/^[A-Z]{3}$/.test(input.currency) || !input.filename?.trim()) throw new Error('SETTLEMENT_PROOF_INCOMPLETE');
    const valueDate = normalizeValueDate(input.valueDate);
    const document = decodeDocument(input.documentBase64);
    const hash = createHash('sha256').update(document).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [payout] } = await client.query(`SELECT p.*,s.net_amount,s.currency,s.status settlement_status,s.merchant_profile_id,s.legal_entity_id FROM konektag.merchant_settlement_payouts p JOIN konektag.merchant_settlements s ON s.id=p.settlement_id WHERE p.id=$1 FOR UPDATE`, [input.payoutId]);
      const workflowStatus = payout?.manual_workflow_status ?? payout?.status;
      if (!payout || payout.settlement_status !== 'BANK_PENDING' || !['BANK_PENDING', 'REJECTED'].includes(workflowStatus)) throw new Error('SETTLEMENT_PAYOUT_NOT_PROOF_SUBMITTABLE');
      if (Number(payout.net_amount) !== input.amount || payout.currency !== input.currency) throw new Error('SETTLEMENT_PROOF_AMOUNT_OR_CURRENCY_MISMATCH');
      await client.query(`INSERT INTO konektag.merchant_settlement_payout_proofs(payout_id,operator_reference,value_date,amount,currency,document,filename,content_hash,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.payoutId, input.operatorReference, valueDate, input.amount, input.currency, document, input.filename, hash, input.submittedBy]);
      await client.query(`UPDATE konektag.merchant_settlement_payouts SET status='SUBMITTED',manual_workflow_status='AWAITING_VERIFICATION',operator_reference=$1,value_date=$2,proof_document=$3,proof_filename=$4,evidence_hash=$5,proof_submitted_by=$6,proof_submitted_at=now(),rejection_reason=NULL,updated_at=now(),version=version+1 WHERE id=$7`, [input.operatorReference, valueDate, document, input.filename, hash, input.submittedBy, input.payoutId]);
      await client.query(`INSERT INTO konektag.admin_actions(admin_id,action_type,target_type,target_id,reason,payload) VALUES($1,'MERCHANT_SETTLEMENT_PROOF_SUBMITTED','merchant_settlement_payout',$2,'Manual proof submitted',$3)`, [input.submittedBy, input.payoutId, JSON.stringify({ operatorReference: input.operatorReference, valueDate: input.valueDate, amount: input.amount, currency: input.currency, hash })]);
      await settlementService.projectManualPayoutEvent(client, { settlement: { id: payout.settlement_id, merchant_profile_id: payout.merchant_profile_id, legal_entity_id: payout.legal_entity_id, net_amount: payout.net_amount, currency: payout.currency, period_end: input.valueDate }, actorId: input.submittedBy, eventType: 'MERCHANT_SETTLEMENT_PROOF_AWAITING_VERIFICATION', sourceReference: input.operatorReference });
      await client.query('COMMIT');
      return { status: 'AWAITING_VERIFICATION', contentHash: hash };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  },

  async verifyManualProof(input: { payoutId: string; verifierId: string; approved: boolean; rejectionReason?: string }) {
    const client = await pool.connect();
    let payout: any;
    try {
      await client.query('BEGIN');
      ({ rows: [payout] } = await client.query(
        `SELECT p.*,s.id AS settlement_row_id,s.net_amount,s.currency,s.legal_entity_id,s.status AS settlement_status,a.provider_account_reference
         FROM konektag.merchant_settlement_payouts p
         JOIN konektag.merchant_settlements s ON s.id=p.settlement_id
         JOIN konektag.merchant_payment_provider_accounts a ON a.id=p.provider_account_id
         WHERE p.id=$1 FOR UPDATE`, [input.payoutId],
      ));
      if (!payout || (payout.manual_workflow_status ?? payout.status) !== 'AWAITING_VERIFICATION') throw new Error('SETTLEMENT_PAYOUT_NOT_VERIFIABLE');
      if (payout.proof_submitted_by === input.verifierId) throw new Error('MAKER_CHECKER_VIOLATION');
      if (!payout.operator_reference || !payout.value_date || !payout.proof_document || !payout.evidence_hash || Number(payout.net_amount) <= 0 || !payout.provider_account_reference) throw new Error('SETTLEMENT_PROOF_INCOMPLETE');
      if (!input.approved) {
        if (!input.rejectionReason?.trim()) throw new Error('SETTLEMENT_PROOF_REJECTION_REASON_REQUIRED');
        await client.query(`UPDATE konektag.merchant_settlement_payouts SET manual_workflow_status='REJECTED',rejection_reason=$1,proof_verified_by=$2,proof_verified_at=now(),updated_at=now(),version=version+1 WHERE id=$3`, [input.rejectionReason, input.verifierId, input.payoutId]);
        await client.query(`UPDATE konektag.merchant_settlement_payout_proofs SET verification_status='REJECTED',verified_by=$1,verified_at=now(),rejection_reason=$2 WHERE payout_id=$3 AND verification_status='AWAITING_VERIFICATION'`, [input.verifierId, input.rejectionReason, input.payoutId]);
        await client.query(`INSERT INTO konektag.admin_actions(admin_id,action_type,target_type,target_id,reason) VALUES($1,'MERCHANT_SETTLEMENT_PROOF_REJECTED','merchant_settlement_payout',$2,$3)`, [input.verifierId, input.payoutId, input.rejectionReason]);
        await settlementService.projectManualPayoutEvent(client, { settlement: { id: payout.settlement_id, merchant_profile_id: payout.merchant_profile_id, legal_entity_id: payout.legal_entity_id, net_amount: payout.net_amount, currency: payout.currency, period_end: payout.value_date }, actorId: input.verifierId, eventType: 'MERCHANT_SETTLEMENT_PROOF_REJECTED', sourceReference: payout.operator_reference });
        await client.query('COMMIT');
        return { ok: true, status: 'REJECTED' };
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
    const evidence = TrustedSettlementEvidence.fromVerifiedServerSource({ settlementId: payout.settlement_id, confirmedBy: input.verifierId, evidenceType: payout.rail === 'BANK' ? 'bank_transfer' : 'psp_confirm', evidenceUrl: `https://internal.konektag.eu/settlement-proofs/${payout.id}`, contentHash: payout.evidence_hash });
    const confirmation = await settlementService.confirmSettlement(evidence);
    if (!confirmation.ok) return confirmation;
    await pool.query(`UPDATE konektag.merchant_settlement_payouts SET status='CONFIRMED',manual_workflow_status='CONFIRMED',proof_verified_by=$1,proof_verified_at=now(),confirmed_at=now(),evidence_url=$2,updated_at=now(),version=version+1 WHERE id=$3 AND manual_workflow_status='AWAITING_VERIFICATION'`, [input.verifierId, evidence.input.evidenceUrl, input.payoutId]);
    await pool.query(`UPDATE konektag.merchant_settlement_payout_proofs SET verification_status='VERIFIED',verified_by=$1,verified_at=now() WHERE payout_id=$2 AND verification_status='AWAITING_VERIFICATION'`, [input.verifierId, input.payoutId]);
    const reconciliationClient = await pool.connect();
    try {
      const service = new ReconciliationService(); const date = new Date().toISOString().slice(0, 10);
      const result = await service.reconcileSettlementBank(reconciliationClient as any, date, payout.legal_entity_id, payout.currency);
      await service.saveReconciliation(reconciliationClient as any, result, date);
    } finally { reconciliationClient.release(); }
    return { ok: true, status: 'CONFIRMED' };
  },
};
