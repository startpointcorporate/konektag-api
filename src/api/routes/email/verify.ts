import type { RouteHandler } from '../../http';
import { keycloakAdapter } from '../../../infrastructure/adapters/keycloak-adapter.ts';
import { OnboardingStateMachine, stateMachine } from '../../../domain/OnboardingStateMachine.ts';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ url }) => {
  try {
    const token = url.searchParams.get('token');
    const uid = url.searchParams.get('uid');

    if (!token || !uid) {
      return new Response('Lien de vérification invalide.', { status: 400 });
    }

    const lang = url.searchParams.get('lang') || 'fr';

    const { rows: [userRow] } = await pool.query(
      `SELECT id, keycloak_id, email_verification_token, email_verified, state, version FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
      [uid]
    );
    if (!userRow) {
      return new Response('Utilisateur introuvable.', { status: 404 });
    }
    if (userRow.email_verified) {
      return redirectOnboarding(lang, userRow.state);
    }
    if (userRow.email_verification_token !== token) {
      return new Response('Token de vérification invalide ou expiré.', { status: 400 });
    }

    // Mark as verified in DB
    await pool.query(
      `UPDATE konektag.users SET email_verified = TRUE, email_verification_token = NULL, updated_at = now() WHERE id = $1`,
      [uid]
    );

    // Faire avancer l'onboarding si l'utilisateur est encore à ACCOUNT_CREATED
    let newState = userRow.state;
    if (newState === 'ACCOUNT_CREATED') {
      stateMachine.assertTransition(newState, 'OTP_VERIFIED');
      await pool.query(
        `UPDATE konektag.users SET state = 'OTP_VERIFIED', version = version + 1, updated_at = now() WHERE id = $1 AND version = $2 AND state = 'ACCOUNT_CREATED'`,
        [uid, userRow.version]
      );
      newState = 'OTP_VERIFIED';
    }

    // Mark as verified in Keycloak
    try {
      await keycloakAdapter.updateUserAttributes(userRow.keycloak_id, {
        email_verified: 'true',
      });
    } catch (err) {
      console.error('[email-verify] Keycloak update failed:', err);
    }

    return redirectOnboarding(lang, newState);
  } catch (err: any) {
    console.error('[email-verify] Error:', err.message);
    return new Response('Erreur technique. Veuillez réessayer.', { status: 500 });
  }
};

function redirectOnboarding(lang: string, state?: string): Response {
  const step = state ? OnboardingStateMachine.projectStep(state as any) : null;
  const onboardingUrl = step ? `/${lang}/onboarding?step=${step}` : `/${lang}/onboarding`;
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email vérifié</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3;url=${onboardingUrl}"><style>body{font-family:Arial,sans-serif;background:#0B0F19;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#1A1F2E;padding:48px;border-radius:16px;text-align:center;max-width:480px}.card h1{color:#D4A44A;font-size:28px;margin:0 0 12px}.card p{color:#a0a0a0;line-height:1.5;margin:0}.card .btn{display:inline-block;margin-top:24px;padding:12px 32px;background:#D4A44A;color:#0B0F19;text-decoration:none;border-radius:8px;font-weight:700}</style></head><body><div class="card"><h1>Email vérifié</h1><p>Votre adresse email a bien été confirmée. Vous allez être redirigé vers la suite de l'onboarding...</p><a href="${onboardingUrl}" class="btn">Continuer l'onboarding</a></div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
