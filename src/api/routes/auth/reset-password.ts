import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { keycloakAdapter } from '../../../infrastructure/adapters/keycloak-adapter.ts';
import crypto from 'node:crypto';

export const POST: RouteHandler = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
  }

  const token = (body.token || '').trim();
  if (!token) {
    return new Response(JSON.stringify({ error: 'TOKEN_MISSING' }), { status: 400 });
  }

  const password = body.password as string;
  if (!password || password.length < 8) {
    return new Response(JSON.stringify({ error: 'PASSWORD_TOO_SHORT' }), { status: 400 });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Find valid token
  const { rows: [resetToken] } = await pool.query(
    `SELECT id, keycloak_id, expires_at, used_at
     FROM konektag.password_reset_tokens
     WHERE token_hash = $1`,
    [tokenHash],
  );

  if (!resetToken) {
    return new Response(JSON.stringify({ error: 'TOKEN_INVALID' }), { status: 400 });
  }

  if (resetToken.used_at) {
    return new Response(JSON.stringify({ error: 'TOKEN_ALREADY_USED' }), { status: 400 });
  }

  if (new Date(resetToken.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: 'TOKEN_EXPIRED' }), { status: 400 });
  }

  // Reset password in Keycloak
  try {
    await keycloakAdapter.resetPassword(resetToken.keycloak_id, password);
  } catch (err: any) {
    console.error('[reset-password] Keycloak error:', err.message);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }

  // Mark token as used
  await pool.query(
    `UPDATE konektag.password_reset_tokens SET used_at = now() WHERE id = $1`,
    [resetToken.id],
  );

  return new Response(JSON.stringify({ success: true }), { status: 200 });
};
