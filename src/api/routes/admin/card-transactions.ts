import type { RequestContext } from '../../http';
import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { adminCardTransactionListQuery } from '../../../application/queries/admin/card-transactions/list.ts';

const CARD_PROVIDERS = new Set(['stripe']);
const SOURCE_TYPES = new Set(['recharge', 'qr_pay', 'transfer', 'api_payment', 'payment_link']);
const STATES = new Set(['pending', 'processing', 'succeeded', 'failed', 'cancelled']);
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

function parseCountry(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) throw new Error('Invalid country');
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

    const result = await adminCardTransactionListQuery.list({
      page: parsePositiveInteger(url.searchParams.get('page'), 1),
      pageSize: Math.min(MAX_PAGE_SIZE, parsePositiveInteger(url.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE)),
      provider: parseEnum(url.searchParams.get('provider'), CARD_PROVIDERS, 'provider'),
      country: parseCountry(url.searchParams.get('country')),
      sourceType: parseEnum(url.searchParams.get('source_type'), SOURCE_TYPES, 'source_type'),
      state: parseEnum(url.searchParams.get('state'), STATES, 'state'),
      dateFrom,
      dateTo,
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
