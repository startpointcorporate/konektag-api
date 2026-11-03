import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { getCorrelationId } from '../../../infrastructure/correlation-id.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
    const keycloakId = user.keycloak_id;

    const body = await request.json();
    const optIn = body.optIn === true;
    const source = body.source || 'settings';

    const { rows: [dbUser] } = await pool.query(
      `SELECT id FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [keycloakId],
    );
    if (!dbUser) {
      return new Response(JSON.stringify({ error: 'Utilisateur introuvable' }), { status: 404 });
    }

    const correlationId = getCorrelationId();
    const now = new Date().toISOString();

    // Mettre à jour le consentement
    const updates: string[] = ['marketing_opt_in = $1', 'updated_at = now()'];
    const params: any[] = [optIn];

    if (optIn) {
      updates.push('marketing_opt_in_at = $' + (params.length + 1));
      params.push(now);
      updates.push('marketing_opt_in_source = $' + (params.length + 1));
      params.push(source);
      updates.push('marketing_opt_out_at = NULL');
    } else {
      updates.push('marketing_opt_out_at = $' + (params.length + 1));
      params.push(now);
    }

    params.push(dbUser.id);
    await pool.query(
      `UPDATE konektag.users SET ${updates.join(', ')} WHERE id = $${params.length}`,
      params,
    );

    // Émettre l'événement MarketingConsentChanged dans l'outbox
    await pool.query(
      `INSERT INTO konektag.outbox_events
       (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ($1, 'User', $2, 'MarketingConsentChanged', 1, $3)`,
      [correlationId, dbUser.id, JSON.stringify({
        userId: dbUser.id,
        keycloakId,
        optIn,
        source,
      })],
    );

    return new Response(JSON.stringify({ success: true, optIn }), { status: 200 });

  } catch (err: any) {
    console.error('[consent/marketing] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
