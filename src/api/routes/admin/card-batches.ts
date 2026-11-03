import type { RouteHandler } from '../../http';
import { cardBatchService } from '../../../application/services/card-batch-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { makerCheckerService } from '../../../application/services/maker-checker-service.ts';

async function adminGuard(locals: any): Promise<{ ok: boolean; user?: any }> {
  if (!locals.user) return { ok: false };
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [locals.user.id]);
  return { ok: u?.role === 'admin', user: locals.user };
}

export const GET: RouteHandler = async ({ locals, url }) => {
  const auth = await adminGuard(locals);
  if (!auth.ok) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const merchant = url.searchParams.get('merchant') || undefined;
  const dateFrom = url.searchParams.get('from') || undefined;
  const dateTo = url.searchParams.get('to') || undefined;

  if (merchant || dateFrom || dateTo) {
    const report = await cardBatchService.getMerchantReport(merchant, dateFrom, dateTo);
    return new Response(JSON.stringify(report), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const result = await cardBatchService.listBatches();
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const auth = await adminGuard(locals);
  if (!auth.ok) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  try {
    const body = await request.json();
    const size = parseInt(body.size);
    const amount = parseInt(body.amount);
    if (!size || !amount || size < 1 || size > 500) {
      return new Response(JSON.stringify({ error: 'INVALID', message: 'Taille (1-500) et montant requis.' }), { status: 400 });
    }
    // Maker-checker recording
    await makerCheckerService.recordPreparation({
      actionType: 'CARD_BATCH_CREATE',
      targetType: 'card_batch',
      targetId: `${size}-${amount}-${Date.now()}`,
      makerId: auth.user.id,
      makerRole: 'admin',
      reason: `Creation batch de ${size} cartes a ${amount}`,
    });
    const countryCode = typeof body.countryCode === 'string' ? body.countryCode.toUpperCase() : 'FR';
    if (!/^[A-Z]{2}$/.test(countryCode)) return new Response(JSON.stringify({ error: 'INVALID_COUNTRY' }), { status: 400 });
    const { csv } = await cardBatchService.createBatch(size, amount, auth.user.id, countryCode);
    return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="cartes-k.csv"' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', message: e.message }), { status: 500 });
  }
};
