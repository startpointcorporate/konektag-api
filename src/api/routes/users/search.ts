import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';

async function searchUsers(currentKeycloakId: string, params: { query?: string; phone?: string; email?: string }) {
  const { query, phone, email } = params;
  if (!query && !phone && !email) return [];

  const conditions: string[] = ['u.deleted_at IS NULL', 'u.id != (SELECT id FROM konektag.users WHERE keycloak_id = $1 LIMIT 1)'];
  const dbParams: any[] = [currentKeycloakId];
  let idx = 2;

  if (query) {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    for (const term of terms) {
      conditions.push(`u.username ILIKE $${idx}`);
      dbParams.push(`%${term}%`);
      idx++;
    }
  }

  if (email) {
    const hash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
    conditions.push(`u.email_hash = $${idx}`);
    dbParams.push(hash);
    idx++;
  }

  if (phone) {
    const hash = crypto.createHash('sha256').update(phone.trim()).digest('hex');
    conditions.push(`u.phone_hash = $${idx}`);
    dbParams.push(hash);
    idx++;
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.country FROM konektag.users u WHERE ${conditions.join(' AND ')} ORDER BY u.username LIMIT 20`,
    dbParams,
  );
  return rows;
}

export const GET: RouteHandler = async ({ url, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
    const rows = await searchUsers(user.keycloak_id, {
      query: url.searchParams.get('q') || undefined,
      phone: url.searchParams.get('phone') || undefined,
      email: url.searchParams.get('email') || undefined,
    });
    return new Response(JSON.stringify(rows), { status: 200 });
  } catch (err: any) {
    console.error('[users/search]', err.message);
    return new Response(JSON.stringify([]), { status: 200 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
    const body = await request.json();
    const rows = await searchUsers(user.keycloak_id, body);
    return new Response(JSON.stringify(rows), { status: 200 });
  } catch (err: any) {
    console.error('[users/search]', err.message);
    return new Response(JSON.stringify([]), { status: 200 });
  }
};
