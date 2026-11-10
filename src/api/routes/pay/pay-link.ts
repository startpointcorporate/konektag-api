import { principalAttemptKey, principalCommandHash, PrincipalReplayConflict, readPrincipalReplay } from '../../../application/services/principal-idempotency-service.ts';
import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { networkLinkService } from '../../../application/link-pay/network-link-service.ts';
import { payNetworkLink } from '../../../application/link-pay/network-payment.ts';

/** Client confirmation of a Link Pay link. Only network links exist; no merchant profile is read. */
export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const { slug, payer_email, transaction_id } = await request.json();
    if (!slug) return Response.json({ error: 'slug required' }, { status: 400 });
    const user = (locals as any).user;
    if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    const attemptKey = principalAttemptKey(slug);
    const commandHash = principalCommandHash([slug, payer_email || null, transaction_id || null]);
    const previous = await readPrincipalReplay(pool, user.id, 'LINK_PAYMENT', attemptKey, commandHash);
    if (previous) return previous;
    const link = await networkLinkService.getBySlug(slug);
    if (!link) return Response.json({ error: 'Lien introuvable, expire ou deja utilise' }, { status: 404 });
    return await payNetworkLink({ link, slug, user, attemptKey, commandHash,
      payerIdentity: payer_email || user.email || null, externalTransactionId: transaction_id || null,
      receipt: { email: payer_email, firstName: user.firstName, locale: user.locale,
        origin: process.env.PUBLIC_SITE_URL || new URL(request.url).origin } });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: err instanceof PrincipalReplayConflict ? 409 : 400 });
  }
};
