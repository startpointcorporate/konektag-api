import type { RouteHandler } from '../../../http';
import { settlementService } from '../../../../application/services/settlement-service.ts';
import pool from '../../../../infrastructure/database/pool.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async (context) => {
  const guard = await requireBackofficePermission('settlements:read')(context.locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);
  const { request } = context;
  const url = new URL(request.url);
  const le = url.searchParams.get('legal_entity') || undefined;
  const merchant = url.searchParams.get('merchant') || undefined;
  const status = url.searchParams.get('status') || undefined;
  try {
    const result = await settlementService.listSettlements({
      legalEntityId: le,
      merchantProfileId: merchant,
      status,
      limit: 50,
    });
    const payouts = await Promise.all(result.map(async settlement => {
      const { rows } = await pool.query(`SELECT id,rail,COALESCE(NULLIF(manual_workflow_status,'NOT_APPLICABLE'),status) AS status,operator_reference,value_date,proof_submitted_at,proof_verified_at,rejection_reason,updated_at FROM konektag.merchant_settlement_payouts WHERE settlement_id=$1`, [settlement.id]);
      return [settlement.id, rows[0] ?? null] as const;
    }));
    const payoutBySettlement = new Map(payouts);
    return new Response(JSON.stringify({
      data: result.map(s => ({
        settlement_id: s.settlementRef,
        operation_id: s.id,
        merchant: s.merchantProfileId,
        merchant_name: s.merchantName,
        legal_entity: s.legalEntityId,
        legal_entity_code: s.legalEntityCode,
        currency: s.currency,
        gross_amount: s.grossAmount,
        commission_amount: s.commissionAmount,
        net_amount: s.netAmount,
        payment_channel: null,
        provider: null,
        provider_reference: null,
        status: s.status,
        settlement_date: s.settlementDate,
        confirmed_at: s.confirmedAt,
        sales_count: s.salesCount,
        payout: payoutBySettlement.get(s.id),
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
