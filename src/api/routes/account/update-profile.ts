import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { encryptionService } from '../../../infrastructure/adapters/encryption-service.ts';
import { getCorrelationId } from '../../../infrastructure/correlation-id.ts';

const ALLOWED_FIELDS = ['firstName', 'lastName', 'locale', 'country'] as const;

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
    const keycloakId = user.keycloak_id;

    const body = await request.json();
    const changedFields: string[] = [];

    // Valider les champs envoyés
    for (const field of Object.keys(body)) {
      if (!(ALLOWED_FIELDS as readonly string[]).includes(field)) {
        return new Response(JSON.stringify({ error: `Champ non autorisé: ${field}` }), { status: 400 });
      }
      changedFields.push(field);
    }

    if (changedFields.length === 0) {
      return new Response(JSON.stringify({ error: 'Aucun champ à mettre à jour' }), { status: 400 });
    }

    const { rows: [dbUser] } = await pool.query(
      `SELECT id, encrypted_data FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [keycloakId],
    );
    if (!dbUser) {
      return new Response(JSON.stringify({ error: 'Utilisateur introuvable' }), { status: 404 });
    }

    // Déchiffrer les données actuelles
    let profile: Record<string, string> = {};
    try {
      profile = JSON.parse(encryptionService.decrypt(dbUser.encrypted_data));
    } catch {
      return new Response(JSON.stringify({ error: 'Erreur de déchiffrement' }), { status: 500 });
    }

    // Appliquer les modifications
    for (const field of changedFields) {
      profile[field] = String(body[field]);
    }

    // Chiffrer et sauvegarder
    const updatedEncrypted = encryptionService.encrypt(JSON.stringify(profile));
    const correlationId = getCorrelationId();

    await pool.query('BEGIN');
    try {
      await pool.query(
        `UPDATE konektag.users
         SET encrypted_data = $1, updated_at = now()
         WHERE id = $2 AND deleted_at IS NULL`,
        [updatedEncrypted, user.id],
      );

      // Émettre l'événement UserProfileUpdated
      await pool.query(
        `INSERT INTO konektag.outbox_events
         (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'User', $2, 'UserProfileUpdated', 1, $3)`,
        [correlationId, user.id, JSON.stringify({
          userId: user.id,
          keycloakId,
          changedFields,
        })],
      );

      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    return new Response(JSON.stringify({ success: true, changedFields }), { status: 200 });

  } catch (err: any) {
    console.error('[account/update-profile] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
