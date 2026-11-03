import type { RouteHandler } from '../../../http';
import { settlementService } from '../../../../application/services/settlement-service.ts';
import pool from '../../../../infrastructure/database/pool.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('settlements:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { params } = context;
  const id = decodeURIComponent(params.id as string);
  try {
    const s = await settlementService.getSettlement(id);
    if (!s) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    const { rows: payoutHistory } = await pool.query(`SELECT p.id,p.rail,p.payout_mode,COALESCE(NULLIF(p.manual_workflow_status,'NOT_APPLICABLE'),p.status) AS status,p.operator_reference,p.value_date,p.proof_filename,p.evidence_hash,p.proof_submitted_by,p.proof_submitted_at,p.proof_verified_by,p.proof_verified_at,p.rejection_reason,p.created_at,p.updated_at,COALESCE(json_agg(json_build_object('id',pr.id,'operator_reference',pr.operator_reference,'value_date',pr.value_date,'amount',pr.amount,'currency',pr.currency,'filename',pr.filename,'content_hash',pr.content_hash,'submitted_by',pr.submitted_by,'submitted_at',pr.submitted_at,'verification_status',pr.verification_status,'verified_by',pr.verified_by,'verified_at',pr.verified_at,'rejection_reason',pr.rejection_reason) ORDER BY pr.submitted_at) FILTER (WHERE pr.id IS NOT NULL),'[]') AS proofs FROM konektag.merchant_settlement_payouts p LEFT JOIN konektag.merchant_settlement_payout_proofs pr ON pr.payout_id=p.id WHERE p.settlement_id=$1 GROUP BY p.id ORDER BY p.created_at`, [s.id]);
    return new Response(JSON.stringify({ settlement: {
      settlement_id: s.settlementRef,
      operation_id: s.id,
      merchant: s.merchantProfileId,
      merchant_name: s.merchantName,
      legal_entity: s.legalEntityId,
      legal_entity_code: s.legalEntityCode,
      currency: s.currency,
      gross_amount: s.grossAmount,
      commission_amount: s.commissionAmount,
      bonus_amount: null,
      adjustment_amount: null,
      net_amount: s.netAmount,
      provider_fee_amount: null,
      payment_channel: null,
      provider: null,
      provider_reference: null,
      status: s.status,
      settlement_date: s.settlementDate,
      sent_at: null,
      confirmed_at: s.confirmedAt,
      value_date: s.periodEnd,
      failure_reason: null,
      reconciliation_status: null,
      created_at: s.createdAt,
      approved_by: s.approvedBy,
      confirmed_by: s.confirmedBy,
      bank_proof_url: s.bankProofUrl,
      sales_count: s.salesCount,
      payout_history: payoutHistory,
    }}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
