import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { loyaltyService, LOYALTY_ACTIONS } from '../../../application/services/loyalty-service.ts';
import type { LoyaltyAction } from '../../../application/services/loyalty-service.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) {
      return new Response(JSON.stringify({ points: 0, level: 'bronze', history: [] }), { status: 200 });
    }

    const keycloakId = user.keycloak_id;
    const userRes = await pool.query('SELECT id FROM konektag.users WHERE keycloak_id = $1', [keycloakId]);
    if (!userRes.rows.length) {
      return new Response(JSON.stringify({ points: 0, level: 'bronze', history: [] }), { status: 200 });
    }

    const userId = userRes.rows[0].id;
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '10');

    const { rows: [loyalty] } = await pool.query(
      'SELECT points, level FROM konektag.loyalty_points WHERE user_id = $1', [userId],
    );
    const { rows: history } = await pool.query(
      'SELECT points, reason, reference, created_at FROM konektag.loyalty_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    );
    const levelName = await loyaltyService.getLevelName(loyalty?.level ?? 'bronze');

    return new Response(JSON.stringify({
      points: loyalty?.points ?? 0,
      level: loyalty?.level ?? 'bronze',
      levelName,
      history,
    }), { status: 200 });
  } catch {
    return new Response(JSON.stringify({ points: 0, level: 'bronze', history: [] }), { status: 200 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(null, { status: 401 });

    const keycloakId = user.keycloak_id;
    const userRes = await pool.query('SELECT id FROM konektag.users WHERE keycloak_id = $1', [keycloakId]);
    if (!userRes.rows.length) return new Response(null, { status: 401 });

    const userId = userRes.rows[0].id;

    const body = await request.json();
    const action = body.action as LoyaltyAction;
    const amount = body.amount ? Number(body.amount) : undefined;
    const reference = typeof body.reference === 'string' ? body.reference.trim() : '';

    if (!action || !LOYALTY_ACTIONS.includes(action)) {
      return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
    }
    if (!reference || reference.length > 100) {
      return new Response(JSON.stringify({ error: 'A stable business reference is required' }), { status: 422 });
    }

    await loyaltyService.earnPoints(userId, action, amount, reference);

    const stats = await loyaltyService.getStats(userId);
    return new Response(JSON.stringify(stats), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
