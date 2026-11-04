import { financialAccountStatus } from '../../../application/services/wallet-integrity-service.ts';
import type { RouteHandler } from '../../http';
import { resolvePointsOwner } from '../../../application/services/pay/points-wallet-service.ts';
import { kPointsBalance } from '../../../application/services/k-points-service.ts';
import { convertStatic } from '../../../application/services/exchange-rate-service.ts';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ balance: 0, cashback: 0, blocked: 0, currency: 'XOF', balance_xof: 0, cashback_xof: 0, source: 'empty' }), { status: 200 });
    const url = new URL(request.url);
    const displayCurrency = url.searchParams.get('currency') || 'EUR';
    const partyId = await resolvePointsOwner(pool as any, user.id);
    const points = await kPointsBalance(partyId);
    const financialControl = await financialAccountStatus(pool,partyId);
    return new Response(JSON.stringify({
      financial_control: financialControl,
      balance: convertStatic(points.balance, 'EUR', displayCurrency),
      cashback: 0, blocked: points.reserved, currency: displayCurrency,
      balance_base: points.balance, cashback_base: 0, credits_base: points.balance, debits_base: 0,
      points_balance: points.balance, points_reserved: points.reserved, points_available: points.available, source: 'points',
    }), { status: 200, headers: { 'Cache-Control': 'no-cache' } });
  } catch (err: any) {
    console.error('[account/balance] wallet balance failed', {
      name: err instanceof Error ? err.name : 'UnknownError',
      code: typeof err?.code === 'string' ? err.code : undefined,
      detail: typeof err?.constraint === 'string' ? err.constraint : undefined,
    });
    return Response.json({ error: 'WALLET_BALANCE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
};
