import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ locals, request }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const url = new URL(request.url);
  const search = url.searchParams.get('q') || '';
  const showBanned = url.searchParams.get('banned') === '1';
  const eligibleMerchantOwner = url.searchParams.get('eligibleMerchantOwner') === '1';
  const autocomplete = url.searchParams.get('autocomplete') === '1';

  let conditions = 'u.deleted_at IS NULL';
  const params: unknown[] = [];
  let idx = 1;

  if (!showBanned || eligibleMerchantOwner) {
    conditions += ' AND u.banned_at IS NULL';
  }
  if (autocomplete && search.trim().length < 2) {
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (search) {
    const placeholder = String.fromCharCode(36) + idx;
    conditions += ` AND (u.username ILIKE ${placeholder} OR u.id::text ILIKE ${placeholder})`;
    params.push(`%${search}%`);
    idx++;
  }

  const { rows: users } = await pool.query(
    `SELECT u.id, u.username, u.locale, u.state, u.country, u.city, u.role, u.created_at, u.banned_at,
            mp.business_name, mp.status AS merchant_status
     FROM konektag.users u
     LEFT JOIN konektag.merchant_profiles mp ON mp.user_id = u.id AND mp.deleted_at IS NULL
     WHERE ${conditions}
     ORDER BY u.username ASC, u.created_at DESC
     LIMIT ${autocomplete ? 20 : (eligibleMerchantOwner ? 100 : 100)}`,
    params,
  );

  return new Response(JSON.stringify(users), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: RouteHandler = async ({ locals, request }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const body = await request.json();
  const targetId = body.userId as string;
  const action = body.action as string;

  if (!targetId || !['ban', 'unban'].includes(action)) {
    return new Response(JSON.stringify({ error: 'INVALID_REQUEST' }), { status: 400 });
  }

  try {
    if (action === 'ban') {
      await pool.query(`UPDATE konektag.users SET banned_at = now() WHERE id = $1 AND deleted_at IS NULL`, [targetId]);
    } else {
      await pool.query(`UPDATE konektag.users SET banned_at = NULL WHERE id = $1`, [targetId]);
    }

    await pool.query(
      `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
      [user.id, crypto.randomUUID(), `ADMIN_USER_${action.toUpperCase()}`, { targetUserId: targetId }],
    );

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    console.error('[admin/users]', err);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
