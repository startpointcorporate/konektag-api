import type { RequestContext } from '../../http';
import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { adminWalletHistoryQuery } from '../../../application/queries/admin/wallet-history/list.ts';

const LIFECYCLES = new Set(['issued', 'approved', 'consumed', 'expired', 'revoked']);
const OPERATION_TYPES = new Set(['recharge', 'qr_pay', 'transfer', 'api_payment', 'payment_link']);
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

async function adminGuard(locals: RequestContext['locals']) {
  const user = locals.user;
  if (!user) return null;
  const { rows: [databaseUser] } = await pool.query(
    'SELECT role FROM konektag.users WHERE id = $1',
    [user.id],
  );
  return databaseUser?.role === 'admin' ? user : null;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDate(value: string | null, parameter: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`Invalid ${parameter}`);
  }
  return value;
}

function parseEnum(value: string | null, allowed: Set<string>, parameter: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (!allowed.has(normalized)) throw new Error(`Invalid ${parameter}`);
  return normalized;
}

function parseCurrency(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw new Error('Invalid currency');
  return normalized;
}

function parsePayer(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) throw new Error('Invalid payer');
  return normalized;
}

export const GET: RouteHandler = async ({ locals, request }) => {
  if (!await adminGuard(locals)) {
    return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  }

  try {
    const url = new URL(request.url);
    const dateFrom = parseDate(url.searchParams.get('dateFrom'), 'dateFrom');
    const dateTo = parseDate(url.searchParams.get('dateTo'), 'dateTo');
    if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('dateFrom must not be after dateTo');

    const result = await adminWalletHistoryQuery.list({
      page: parsePositiveInteger(url.searchParams.get('page'), 1),
      pageSize: Math.min(MAX_PAGE_SIZE, parsePositiveInteger(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE)),
      lifecycle: parseEnum(url.searchParams.get('lifecycle'), LIFECYCLES, 'lifecycle'),
      operationType: parseEnum(url.searchParams.get('operationType'), OPERATION_TYPES, 'operationType'),
      currency: parseCurrency(url.searchParams.get('currency')),
      dateFrom,
      dateTo,
      payer: parsePayer(url.searchParams.get('payer')),
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request';
    return new Response(JSON.stringify({ error: 'INVALID_REQUEST', message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
