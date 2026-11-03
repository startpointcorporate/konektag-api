import type { RouteHandler } from '../../http';
import { emailService } from '../../../application/services/resend-service.ts';
import { encryptionService } from '../../../infrastructure/adapters/encryption-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import crypto from 'node:crypto';

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const user = (locals as any).user;
    if (!user) {
      return new Response(JSON.stringify({ error: 'Non authentifié' }), { status: 401 });
    }

    const { rows: [userRow] } = await pool.query(
      `SELECT id, encrypted_data, email_verified FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [user.sub]
    );
    if (!userRow) {
      return new Response(JSON.stringify({ error: 'Utilisateur introuvable' }), { status: 404 });
    }
    if (userRow.email_verified) {
      return new Response(JSON.stringify({ error: 'Email déjà vérifié' }), { status: 400 });
    }

    const decrypted = JSON.parse(encryptionService.decrypt(userRow.encrypted_data));
    const email = decrypted.email;
    const firstName = decrypted.firstName || '';
    const locale = (user as any).locale || 'fr';

    const token = crypto.randomBytes(32).toString('hex');
    const origin = request.headers.get('origin') || '';
    const verificationUrl = `${origin}/api/email/verify?token=${token}&uid=${userRow.id}&lang=${locale}`;

    await pool.query(
      `UPDATE konektag.users SET email_verification_token = $1, email_verification_sent_at = now(), updated_at = now() WHERE id = $2`,
      [token, userRow.id]
    );

    const lang = locale === 'en' ? 'en' : 'fr';
    const templateVars: Record<string, string> = {
      firstName,
      verificationUrl,
      currentYear: new Date().getFullYear().toString(),
    };
    templateVars.PINCODE = String(Math.floor(100000 + Math.random() * 900000));
    await emailService.sendTemplate('confirmEmail', lang, email, templateVars);

    return new Response(JSON.stringify({ success: true, message: 'Email de vérification envoyé' }), { status: 200 });
  } catch (err: any) {
    console.error('[email-verify] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
