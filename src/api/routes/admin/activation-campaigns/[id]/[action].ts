import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';

const TRANSITIONS: Record<string, string[]> = {
  activate: ['draft', 'paused'],
  resume: ['paused'],
  pause: ['active'],
  complete: ['active', 'paused'],
  archive: ['draft', 'completed', 'paused'],
};

async function adminGuard(locals: any) {
  const user = locals.user;
  if (!user) return null;
  const { rows } = await pool.query<{ role: string }>(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  return rows[0]?.role === 'admin' ? user : null;
}

export const POST: RouteHandler = async ({ locals, params, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const action = params.action || '';
  const allowed = TRANSITIONS[action];
  if (!allowed) return new Response(JSON.stringify({ error: 'UNKNOWN_ACTION' }), { status: 404 });
  const body = await request.json().catch(() => ({}));
  const target = action === 'activate' || action === 'resume' ? 'active' : action === 'pause' ? 'paused' : action === 'complete' ? 'completed' : 'archived';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; status: string; version: number }>(
      `UPDATE konektag.activation_campaigns
       SET status = $1, updated_by = $2, updated_at = now(), version = version + 1
       WHERE id = $3 AND deleted_at IS NULL AND status = ANY($4::varchar[])
         AND ($5::int IS NULL OR version = $5)
       RETURNING id, status, version`,
      [target, admin.id, params.id, allowed, Number.isSafeInteger(body.version) ? body.version : null],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return new Response(JSON.stringify({ error: 'INVALID_TRANSITION_OR_VERSION_CONFLICT' }), { status: 409 });
    }
    const payload = { action, previousStatuses: allowed, newStatus: target };
    await client.query(
      `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
       VALUES ($1, $2, 'activation_campaign', $3, $4, $5)`,
      [admin.id, `ACTIVATION_CAMPAIGN_${action.toUpperCase()}`, params.id, body.reason || `Campaign ${action}`, JSON.stringify(payload)],
    );
    await client.query(
      `INSERT INTO konektag.activation_campaign_audit (campaign_id, actor_id, action, payload)
       VALUES ($1, $2, $3, $4)`, [params.id, admin.id, action, JSON.stringify(payload)],
    );
    await client.query('COMMIT');
    return new Response(JSON.stringify({ campaign: rows[0] }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error.code === '23505' && action === 'activate') {
      return new Response(JSON.stringify({ error: 'ANOTHER_CAMPAIGN_IS_ACTIVE' }), { status: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
};
