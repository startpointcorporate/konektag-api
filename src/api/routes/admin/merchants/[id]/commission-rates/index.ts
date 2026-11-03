import type { RouteHandler } from '../../../../../http';
import { cardBatchService } from '../../../../../../application/services/card-batch-service.ts';
import pool from '../../../../../../infrastructure/database/pool.ts';

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return false;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  return u?.role === 'admin';
}

export const GET: RouteHandler = async ({ locals, params }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const profileId = params.id as string;
  const rates = await cardBatchService.getCommissionRates(profileId);
  return new Response(JSON.stringify({ rates }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const PUT: RouteHandler = async ({ locals, request, params }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const profileId = params.id as string;
  const body = await request.json();
  const { country_code, commission_rate, is_active } = body;

  if (!country_code || country_code.length !== 2) return new Response(JSON.stringify({ error: 'INVALID', message: 'Code pays ISO requis (2 lettres).' }), { status: 400 });
  if (typeof commission_rate !== 'number' || commission_rate < 0 || commission_rate > 100) return new Response(JSON.stringify({ error: 'INVALID', message: 'Taux entre 0 et 100 requis.' }), { status: 400 });

  await cardBatchService.upsertCommissionRate(profileId, country_code.toUpperCase(), commission_rate, is_active !== false);
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const DELETE: RouteHandler = async ({ locals, request, params }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const body = await request.json();
  const { id } = body;
  if (!id) return new Response(JSON.stringify({ error: 'INVALID' }), { status: 400 });
  await cardBatchService.deleteCommissionRate(id);
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
