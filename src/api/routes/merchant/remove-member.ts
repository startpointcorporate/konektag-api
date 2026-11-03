// DEPRECATED: Use POST /api/merchant/members/remove instead
// Wrapper de compatibilité — sera supprimé après migration frontend
import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantNotOwnerError } from '../../../domain/MerchantErrors.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  console.warn('[DEPRECATED] POST /api/merchant/remove-member — use POST /api/merchant/members/remove');
  try {
    const actor = locals.user;
    if (!actor) return new Response(JSON.stringify({ error: 'Non authentifié' }), { status: 401 });

    const body = await request.json();
    const { merchantId, userKeycloakId } = body;
    if (!merchantId || !userKeycloakId) {
      return new Response(JSON.stringify({ error: 'merchantId et userKeycloakId requis' }), { status: 400 });
    }

    await merchantService.requireOwnerOrManager(merchantId, actor.id);
    const { rows: [user] } = await pool.query(
      `SELECT id FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [userKeycloakId],
    );
    if (!user) return new Response(JSON.stringify({ error: 'Utilisateur introuvable' }), { status: 404 });

    await merchantService.removeMember(merchantId, user.id, userKeycloakId);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    if (err instanceof MerchantNotOwnerError) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
    console.error('[merchant/remove-member] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
