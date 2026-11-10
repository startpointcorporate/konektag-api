import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';

export const POST: RouteHandler = async ({ locals, params }) => {
  const user = locals.user;
  const slug = params.slug;
  if (!user?.id) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  if (!slug) return Response.json({ error: 'LINK_REQUIRED' }, { status: 400 });

  try {
    const { rows: [pending] } = await pool.query(
      `INSERT INTO konektag.pending_link_payments (payer_user_id, checkout_intent_id)
       SELECT $1, ci.id
       FROM konektag.checkout_intents ci
       JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id
       WHERE ci.public_id = $2
         AND ci.source_type = 'payment_link'
         AND ci.status = 'ISSUED'
         AND (ci.expiration IS NULL OR ci.expiration > now())
       ON CONFLICT (payer_user_id, checkout_intent_id)
       DO NOTHING
       RETURNING id`,
      [user.id, slug],
    );
    if (pending) return Response.json({ success: true, pendingId: pending.id });
    const { rows: [existing] } = await pool.query(
      `SELECT plp.id
       FROM konektag.pending_link_payments plp
       JOIN konektag.checkout_intents ci ON ci.id = plp.checkout_intent_id
       JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id
       WHERE plp.payer_user_id = $1
         AND ci.public_id = $2
         AND ci.source_type = 'payment_link'
         AND ci.status = 'ISSUED'
         AND (ci.expiration IS NULL OR ci.expiration > now())
       LIMIT 1`,
      [user.id, slug],
    );
    if (!existing) return Response.json({ error: 'LINK_NOT_AVAILABLE' }, { status: 404 });
    return Response.json({ success: true, pendingId: existing.id });
  } catch (error) {
    console.error('[link-pay-resume] failed', error);
    return Response.json({ error: 'LINK_PAY_RESUME_FAILED' }, { status: 500 });
  }
};
