import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { adminRechargeListQuery } from '../../../../application/queries/admin/recharges/list.ts';

const ALLOWED_SORT = ['created_at', 'requested_amount', 'recharge_status'];
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals, request }) => {
  if (!await adminGuard(locals)) {
    return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  }

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10)));
  const sort = ALLOWED_SORT.includes(url.searchParams.get('sort') || '') ? url.searchParams.get('sort')! : 'created_at';
  const direction = url.searchParams.get('direction') === 'asc' ? 'asc' as const : 'desc' as const;

  try {
    const result = await adminRechargeListQuery.list({
      page,
      pageSize,
      sort: sort as any,
      direction,
      search: url.searchParams.get('q') || undefined,
      rechargeStatus: url.searchParams.get('rechargeStatus') || undefined,
      providerStatus: url.searchParams.get('providerStatus') || undefined,
      ledgerStatus: url.searchParams.get('ledgerStatus') || undefined,
      paymentMethod: url.searchParams.get('paymentMethod') || undefined,
      paymentProvider: url.searchParams.get('paymentProvider') || undefined,
      currency: url.searchParams.get('currency') || undefined,
      country: url.searchParams.get('country') || undefined,
      dateFrom: url.searchParams.get('dateFrom') || undefined,
      dateTo: url.searchParams.get('dateTo') || undefined,
      notCredited: url.searchParams.get('notCredited') === '1',
      hasAnomaly: url.searchParams.get('hasAnomaly') === '1',
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[admin/recharges]', err);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', message: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
