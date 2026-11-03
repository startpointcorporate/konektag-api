import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { encryptionService } from '../../../infrastructure/adapters/encryption-service.ts';
import { emailService } from '../../../application/services/resend-service.ts';
import crypto from 'node:crypto';

const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

export const POST: RouteHandler = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'EMAIL_INVALID' }), { status: 400 });
  }

  const emailHash = crypto.createHash('sha256').update(email).digest('hex');

  // Find user by email hash
  const { rows: [user] } = await pool.query(
    `SELECT id, keycloak_id, encrypted_data, locale FROM konektag.users WHERE email_hash = $1 AND deleted_at IS NULL`,
    [emailHash],
  );

  // Always return success (don't reveal if email exists)
  if (!user) {
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  // Verify the decrypted email matches (guard against hash collision)
  let decrypted: any;
  try {
    decrypted = JSON.parse(encryptionService.decrypt(user.encrypted_data));
  } catch {
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }

  if (!decrypted.email || decrypted.email.toLowerCase() !== email) {
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  // Generate token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    await pool.query(
      `INSERT INTO konektag.password_reset_tokens (keycloak_id, email_hash, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [user.keycloak_id, emailHash, tokenHash, TOKEN_EXPIRY_SECONDS],
    );
  } catch {
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }

  // Build reset link
  const siteUrl = process.env.PUBLIC_SITE_URL || 'https://konektag.eu';
  const locale = user.locale || 'fr';
  const resetUrl = `${siteUrl}/${locale}/auth/reset-password?token=${token}`;

  // Send email
  await emailService.sendTemplate('resetPassword', locale, email, {
    firstName: decrypted.firstName || '',
    resetUrl: resetUrl,
    currentYear: new Date().getFullYear().toString(),
    PINCODE: '',
  }).catch(err => console.error('[forgot-password] Email error:', err));

  return new Response(JSON.stringify({ success: true }), { status: 200 });
};
