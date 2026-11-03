import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';
import { confirmCryptoRecharge } from '../../../../../application/commands/admin/confirm-crypto-command.ts';

const MIN_AMOUNT = 1;
const MAX_AMOUNT = 100_000_000;
const MIN_CONFIRMATIONS = 2;

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return { ...user, dbId: u.id };
}

export const POST: RouteHandler = async ({ locals, request, params }) => {
  const admin = await adminGuard(locals);
  if (!admin) {
    return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  }

  const rechargeName = decodeURIComponent(params.id as string);
  if (!rechargeName) {
    return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
  }

  const transactionHash = (body.transactionHash || '').trim();
  if (!transactionHash) {
    return new Response(JSON.stringify({ error: 'MISSING_FIELD', field: 'transactionHash' }), { status: 400 });
  }

  const cryptoNetwork = (body.cryptoNetwork || '').trim();
  if (!cryptoNetwork) {
    return new Response(JSON.stringify({ error: 'MISSING_FIELD', field: 'cryptoNetwork' }), { status: 400 });
  }

  const confirmations = parseInt(String(body.confirmations), 10);
  if (!confirmations || confirmations < MIN_CONFIRMATIONS) {
    return new Response(JSON.stringify({
      error: 'INSUFFICIENT_CONFIRMATIONS',
      message: `Nombre de confirmations minimum : ${MIN_CONFIRMATIONS}`,
    }), { status: 400 });
  }

  const amountReceived = parseInt(String(body.amountReceived), 10);
  if (!amountReceived || amountReceived < MIN_AMOUNT || amountReceived > MAX_AMOUNT) {
    return new Response(JSON.stringify({
      error: 'INVALID_AMOUNT',
      message: `Le montant doit \u00EAtre entre ${MIN_AMOUNT} et ${MAX_AMOUNT}`,
    }), { status: 400 });
  }

  const currency = (body.currency || '').toUpperCase().trim() || undefined;
  const notes = (body.notes || '').trim() || undefined;

  try {
    const result = await confirmCryptoRecharge({
      rechargeName,
      adminId: admin.dbId,
      transactionHash,
      cryptoNetwork,
      confirmations,
      amountReceived,
      currency,
      notes,
    });

    return new Response(JSON.stringify({
      success: true,
      rechargeName: result.rechargeName,
      ledgerEntryId: result.ledgerEntryId,
      message: result.previousStatus
        ? 'Recharge d\u00E9j\u00E0 confirm\u00E9e (idempotent)'
        : 'Recharge Crypto confirm\u00E9e avec succ\u00E8s',
    }), { status: 200 });
  } catch (err: any) {
    const statusCode = err.statusCode || 500;
    console.error(`[admin/recharges/confirm-crypto] ${rechargeName}:`, err.message);
    return new Response(JSON.stringify({ error: err.message || 'SERVER_ERROR' }), { status: statusCode });
  }
};
