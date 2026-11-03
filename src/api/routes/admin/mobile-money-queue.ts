import type { RequestContext } from '../../http';
import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { adminMobileMoneyQueueQuery } from '../../../application/queries/admin/mobile-money-queue/list.ts';

const MAX_PAGE_SIZE = 100;

async function adminGuard(locals: RequestContext['locals']) {
  if (!locals.user) return null;
  const { rows } = await pool.query<{ role: string }>('SELECT role FROM konektag.users WHERE id = $1', [locals.user.id]);
  return rows[0]?.role === 'admin' ? locals.user : null;
}

function positiveInteger(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function optionalCode(value: string | null, field: string, max: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!new RegExp(`^[A-Z0-9_-]{1,${max}}$`).test(normalized)) throw new Error(`Invalid ${field}`);
  return normalized;
}

function optionalAge(value: string | null): number | undefined {
  if (!value) return undefined;
  const age = Number(value);
  if (!Number.isSafeInteger(age) || age < 1 || age > 8_760) throw new Error('Invalid age');
  return age;
}

export const GET: RouteHandler = async ({ locals, request }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  try {
    const url = new URL(request.url);
    const sourceType = url.searchParams.get('source_type');
    if (sourceType && sourceType !== 'api_payment') throw new Error('Invalid source_type');
    const country = url.searchParams.get('country');
    if (country && !/^[A-Za-z]{2}$/.test(country)) throw new Error('Invalid country');
    const result = await adminMobileMoneyQueueQuery.list({
      page: positiveInteger(url.searchParams.get('page'), 1, 1_000_000),
      pageSize: positiveInteger(url.searchParams.get('pageSize'), 25, MAX_PAGE_SIZE),
      country: country?.toUpperCase(),
      provider: optionalCode(url.searchParams.get('provider'), 'provider', 50),
      operator: optionalCode(url.searchParams.get('operator'), 'operator', 50),
      sourceType: sourceType as 'api_payment' | undefined,
      ageHours: optionalAge(url.searchParams.get('age')),
    });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid request' }), { status: 400 });
  }
};
