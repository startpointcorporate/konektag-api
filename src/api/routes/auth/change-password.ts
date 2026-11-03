import type { RouteHandler } from '../../http';
import { keycloakAdapter } from '../../../infrastructure/bootstrap.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;

  if (!user) {
    return new Response(
      JSON.stringify({ message: 'Unauthorized' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  let body: any;

  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ message: 'Requête invalide.' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const currentPassword = body.currentPassword as string;
  const newPassword = body.newPassword as string;

  if (!currentPassword || !newPassword) {
    return new Response(
      JSON.stringify({
        message: 'Current password and new password are required.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  if (newPassword.length < 8) {
    return new Response(
      JSON.stringify({
        message: 'Le nouveau mot de passe doit contenir au moins 8 caractères.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /*
   * Verify the current password using the existing Keycloak
   * Resource Owner Password Credentials flow.
   */
  try {
    await keycloakAdapter.directGrant(
      user.username || user.email || '',
      currentPassword,
    );
  } catch {
    return new Response(
      JSON.stringify({ message: 'Mot de passe actuel incorrect.' }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /*
   * Change the password through the existing Keycloak Admin API adapter.
   */
  try {
    await keycloakAdapter.resetPassword(
      user.keycloak_id,
      newPassword,
    );
  } catch (error) {
    console.error(
      '[change-password] Keycloak password reset error:',
      error instanceof Error ? error.message : String(error),
    );

    return new Response(
      JSON.stringify({
        message: 'Erreur lors du changement de mot de passe.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      message: 'Mot de passe modifié avec succès.',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
};
