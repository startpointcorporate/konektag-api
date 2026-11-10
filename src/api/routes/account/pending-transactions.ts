import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user?.id) {
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  try {
  // Expire only abandoned checkouts: no real provider attempt has been created.
  // Once Stripe/PawaPay/manual has a provider reference, its own lifecycle owns
  // the transaction and we never expire it just because the checkout TTL elapsed.
  await pool.query(
    `UPDATE konektag.api_payment_orders o
       SET state='expired', updated_at=now()
     WHERE o.target_user_id=$1
       AND o.state IN ('pending','processing','awaiting_mobile_money')
       AND o.created_at < now() - (COALESCE(NULLIF(current_setting('app.checkout_expiration_minutes', true),''),'60') || ' minutes')::interval
       AND NOT EXISTS (
         SELECT 1 FROM konektag.payment_provider_attempts ppa
         WHERE ppa.source_type='api_payment'
           AND ppa.source_id::text=o.id::text
           AND ppa.provider_reference IS NOT NULL
       )`,
    [user.id],
  );

  const { rows } = await pool.query(
    `SELECT
       o.id,
       o.merchant_transaction_id AS "reference",
       o.label,
       o.currency,
       o.total_amount AS "totalAmount",
       CASE
         WHEN o.order_purpose = 'wallet_recharge'
          AND o.state = 'paid'
          AND COALESCE(pa.status, '') <> 'completed'
         THEN 'finalizing'
         ELSE o.state
       END AS state,
       pa.status AS "acquisitionStatus",
       o.payment_method AS "paymentMethod",
       o.payment_country AS "paymentCountry",
       CASE WHEN EXISTS (
         SELECT 1 FROM konektag.payment_provider_attempts aged
         WHERE aged.source_type='api_payment' AND aged.source_id::text=o.id::text
           AND aged.provider IN ('stripe','pawapay')
           AND aged.state IN ('pending','processing')
           AND aged.updated_at < now() - interval '2 hours'
       ) THEN true ELSE false END AS "reconciliationRequired",
       o.created_at AS "createdAt",
       o.updated_at AS "updatedAt",
       o.checkout_token_hash,
       EXISTS (
         SELECT 1 FROM konektag.payment_provider_attempts ppa
         WHERE ppa.source_type='api_payment'
           AND ppa.source_id::text=o.id::text
           AND ppa.provider IN ('stripe','pawapay','manual')
           AND ppa.provider_reference IS NOT NULL
       ) AS "canClaimPayment",
       CASE WHEN o.order_purpose = 'wallet_recharge' THEN 'wallet_recharge' ELSE o.order_purpose END AS "type"
     FROM konektag.api_payment_orders o
     LEFT JOIN konektag.points_acquisitions pa
       ON pa.order_id = o.id AND o.order_purpose = 'wallet_recharge'
     WHERE (
       o.state IN ('pending','processing','awaiting_mobile_money')
       OR (
         o.order_purpose = 'wallet_recharge'
         AND o.state = 'paid'
         AND COALESCE(pa.status, '') <> 'completed'
       )
     )
       AND o.target_user_id = $1
     ORDER BY o.created_at DESC
     LIMIT 20`,
    [user.id],
  );

  const { rows: linkRows } = await pool.query(
    `SELECT
       plp.id,
       ci.public_id AS slug,
       nl.beneficiary_name AS label,
       ci.currency,
       ci.amount AS "totalAmount",
       ci.quantity_k AS "quantityK",
       ci.expiration AS "expiresAt",
       plp.created_at AS "createdAt",
       plp.updated_at AS "updatedAt",
       'payment_link'::text AS type
     FROM konektag.pending_link_payments plp
     JOIN konektag.checkout_intents ci ON ci.id = plp.checkout_intent_id
     JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id
     WHERE plp.payer_user_id = $1
       AND ci.source_type = 'payment_link'
       AND ci.status = 'ISSUED'
       AND (ci.expiration IS NULL OR ci.expiration > now())
     ORDER BY plp.created_at DESC`,
    [user.id],
  );

  // The raw checkout token is intentionally not persisted, only its hash.
  // Link Pay resumptions use the public Link Pay slug instead.
  return Response.json({
    transactions: [
      ...linkRows,
      ...rows.map(({ checkout_token_hash: _hash, ...row }) => row),
    ].slice(0, 20),
  });
  } catch (error) {
    console.error('[pending-transactions] query failed', error);
    return Response.json({ error: 'PENDING_TRANSACTIONS_UNAVAILABLE' }, { status: 500 });
  }
};
