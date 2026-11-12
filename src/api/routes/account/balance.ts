import { financialAccountStatus } from '../../../application/services/wallet-integrity-service.ts';
import type { RouteHandler } from '../../http';
import { resolvePointsOwner } from '../../../application/services/pay/points-wallet-service.ts';
import { kPointsBalance } from '../../../application/services/k-points-service.ts';
import { exchangeRateService } from '../../../application/services/exchange-rate-service.ts';
import { walletDisplayCurrencyForCountry } from '../../../application/services/operation-currency-service.ts';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    const url = new URL(request.url);
    const {rows:[profile]}=await pool.query(`SELECT u.country,up.preferred_currency FROM konektag.users u
      LEFT JOIN konektag.user_preferences up ON up.user_id=u.id AND up.deleted_at IS NULL WHERE u.id=$1`,[user.id]);
    const displayCurrency=(url.searchParams.get('currency')||profile?.preferred_currency||walletDisplayCurrencyForCountry(profile?.country)).toUpperCase();
    if(!exchangeRateService.isSupported(displayCurrency))return Response.json({error:'UNSUPPORTED_CURRENCY'},{status:400});
    const partyId = await resolvePointsOwner(pool as any, user.id);
    const points = await kPointsBalance(partyId);
    const {rows:[pending]}=await pool.query(`SELECT COALESCE(sum(quantity_k),0)::text AS net FROM (
      SELECT CASE WHEN le.entry_side='credit' THEN le.amount ELSE -le.amount END AS quantity_k
      FROM konektag.ledger_entries le LEFT JOIN konektag.financial_transactions ft ON ft.id=le.transaction_id
      LEFT JOIN konektag.k_operations ko ON ko.id=le.k_operation_id
      WHERE le.party_id=$1 AND le.account_code='1000' AND le.currency='K'
        AND le.gl_scope='GLOBAL_USER_GL' AND upper(COALESCE(ko.status,ft.status)) IN ('PENDING','PROCESSING')
      UNION ALL
      SELECT o.points_quantity::numeric AS quantity_k
      FROM konektag.api_payment_orders o
      LEFT JOIN LATERAL (SELECT a.state FROM konektag.payment_provider_attempts a
        WHERE a.source_type='api_payment' AND a.source_id::text=o.id::text
        ORDER BY a.created_at DESC,a.id DESC LIMIT 1) attempt ON true
      WHERE o.target_user_id=$2 AND o.order_purpose='wallet_recharge'
        AND o.order_metadata ? 'erpnextPointsK'
        AND o.points_quantity>0
        AND o.state IN ('pending','processing','awaiting_mobile_money','paid')
        AND (o.state='paid' OR COALESCE(attempt.state,'pending') IN ('pending','processing'))
        AND NOT EXISTS(SELECT 1 FROM konektag.ledger_entries le WHERE le.points_order_id=o.id)
    ) pending_movements`,[partyId,user.id]);
    const pendingK=Number(pending?.net??0);
    const fx=await exchangeRateService.convert(1,'EUR',displayCurrency);
    if(!fx)return Response.json({error:'EXCHANGE_RATE_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});
    const evidence=await exchangeRateService.getRateEvidence('EUR',displayCurrency);
    const financialControl = await financialAccountStatus(pool,partyId);
    return Response.json({
      financial_control: financialControl,
      balance: Math.round(points.balance*fx.rate*1e6)/1e6,
      cashback: 0, blocked: points.reserved, currency: displayCurrency,
      balance_base: points.balance, cashback_base: 0, credits_base: points.balance, debits_base: 0,
      points_balance: points.balance, points_reserved: points.reserved, points_available: points.available,
      points_pending_net:pendingK,source:'ledger',valuation:{currency:displayCurrency,rate:fx.rate,
       source:evidence?.source??'static_fallback',date:evidence?.valuedAt??null,kind:'INDICATIVE'},
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (err: any) {
    console.error('[account/balance] wallet balance failed', {
      name: err instanceof Error ? err.name : 'UnknownError',
      code: typeof err?.code === 'string' ? err.code : undefined,
      detail: typeof err?.constraint === 'string' ? err.constraint : undefined,
    });
    return Response.json({ error: 'WALLET_BALANCE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
};
