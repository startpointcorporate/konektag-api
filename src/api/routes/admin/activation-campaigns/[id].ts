import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

async function adminGuard(locals: any) {
  const user = locals.user;
  if (!user) return null;
  const { rows } = await pool.query<{ role: string }>(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  return rows[0]?.role === 'admin' ? user : null;
}

export const GET: RouteHandler = async ({ locals, params }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(json_agg(m ORDER BY m.sort_order) FILTER (WHERE m.id IS NOT NULL), '[]') AS milestones
     FROM konektag.activation_campaigns c
     LEFT JOIN konektag.activation_milestones m ON m.campaign_id = c.id
     WHERE c.id = $1 AND c.deleted_at IS NULL
     GROUP BY c.id`,
    [params.id],
  );
  if (!rows[0]) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
  return new Response(JSON.stringify({ campaign: rows[0] }), { headers: { 'Content-Type': 'application/json' } });
};

export const PATCH: RouteHandler = async ({ locals, params, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const body = await request.json();
  if (!Number.isSafeInteger(body.version) || !['draft', 'paused'].includes(body.status ?? 'draft')) {
    return new Response(JSON.stringify({ error: 'INVALID_UPDATE' }), { status: 400 });
  }
  const { rows } = await pool.query(
    `UPDATE konektag.activation_campaigns
     SET public_title = COALESCE($1, public_title), public_description = COALESCE($2, public_description),
         baseline = COALESCE($3, baseline), updated_by = $4, updated_at = now(), version = version + 1
     WHERE id = $5 AND deleted_at IS NULL AND status IN ('draft', 'paused') AND version = $6
     RETURNING id, version`,
    [body.publicTitle ?? null, body.publicDescription ?? null, body.baseline ?? null, admin.id, params.id, body.version],
  );
  if (!rows[0]) return new Response(JSON.stringify({ error: 'VERSION_CONFLICT_OR_LOCKED' }), { status: 409 });
  return new Response(JSON.stringify({ campaign: rows[0] }), { headers: { 'Content-Type': 'application/json' } });
};
