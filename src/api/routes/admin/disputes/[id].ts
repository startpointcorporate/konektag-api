import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';

export const GET: RouteHandler = async ({ params, locals }) => {
  const guard = await requireBackofficePermission('compliance:read')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  const { rows: [dispute] } = await pool.query(
    `SELECT d.*, u.username FROM konektag.disputes d
     JOIN konektag.users u ON u.id = d.user_id
     WHERE d.id = $1 AND d.deleted_at IS NULL`,
    [params.id],
  );
  if (!dispute) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
  return new Response(JSON.stringify(dispute), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const PUT: RouteHandler = async ({ params, request, locals }) => {
  const guard = await requireBackofficePermission('compliance:write')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  try {
    const body = await request.json();
    const { rows: [updated] } = await pool.query(
      `UPDATE konektag.disputes SET status = $1, resolution = $2, resolved_by = $3, resolved_at = now(), updated_at = now()
       WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
      [body.status || 'INVESTIGATING', body.resolution || null, guard.user!.id, params.id],
    );
    if (!updated) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
