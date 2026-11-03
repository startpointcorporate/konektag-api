import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { requireBackofficePermission, forbiddenResponse } from '../../../../application/services/backoffice-permission-service.ts';
import crypto from 'node:crypto';

export const GET: RouteHandler = async ({ locals, url }) => {
  const guard = await requireBackofficePermission('compliance:read')(locals);
  if (!guard.authorized) return forbiddenResponse(guard.reason);

  const status = url.searchParams.get('status');
  const limit = parseInt(url.searchParams.get('limit') || '50');

  const params: any[] = [];
  let where = '';
  if (status) { where = 'WHERE d.status = $1'; params.push(status); }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT d.*, u.username FROM konektag.disputes d
     JOIN konektag.users u ON u.id = d.user_id
     ${where} ORDER BY d.created_at DESC LIMIT $${params.length}`,
    params,
  );

  return new Response(JSON.stringify({ disputes: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  try {
    const body = await request.json();
    const disputeType = body.disputeType || 'litige_commercial';
    const slaDays: Record<string, number> = { litige_commercial: 14, incident_psp: 7, chargeback: 30, remboursement_legal: 30 };
    const slaDue = slaDays[disputeType] || 14;

    const { rows: [dispute] } = await pool.query(
      `INSERT INTO konektag.disputes (dispute_ref, user_id, operation_id, dispute_type, description, sla_due_date)
       VALUES ($1, $2, $3, $4, $5, (CURRENT_DATE + ($6 || ' days')::interval))
       RETURNING *`,
      [`DISPUTE-${crypto.randomUUID().slice(0, 8)}`, user.id, body.operationId, disputeType, body.description, slaDue],
    );
    return new Response(JSON.stringify(dispute), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
