import pool from '../../../infrastructure/database/pool.ts';
import Stripe from 'stripe';
import { ledgerService } from '../../services/ledger-service.ts';
import { emailService } from '../../services/resend-service.ts';
import { encryptionService } from '../../../infrastructure/adapters/encryption-service.ts';
import { getCorrelationId } from '../../../infrastructure/correlation-id.ts';
import crypto from 'node:crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export interface RefundStripeInput {
  rechargeName: string;
  adminId: string;
  reason: string;
  amount?: number;
}

export interface RefundStripeResult {
  success: boolean;
  rechargeName: string;
  stripeRefundId?: string;
  previousStatus?: string;
}

/**
 * Refund a Stripe card recharge.
 *
 * Transaction sequence:
 *   1. Call Stripe API to refund the PaymentIntent
 *   2. BEGIN
 *   3. SELECT ... FOR UPDATE (lock projection)
 *   4. Verify preconditions (exists, confirmed, card)
 *   5. INSERT ledger reversal entry
 *   6. INSERT admin_actions
 *   7. INSERT outbox_events (RechargeReversed)
 *   8. COMMIT
 *   9. Notify user
 *
 * Idempotent: if already reversed, returns success.
 */
export async function refundStripeRecharge(input: RefundStripeInput): Promise<RefundStripeResult> {
  const { rechargeName, adminId, reason, amount } = input;
  const correlationId = getCorrelationId() || crypto.randomUUID();

  // Load projection for validation and to get the PI reference
  const { rows: [proj] } = await pool.query(
    `SELECT r.id, r.recharge_name, r.keycloak_id, r.requested_amount, r.requested_currency,
            r.recharge_status, r.credited_amount, r.payment_method, r.payment_provider,
            r.stripe_payment_intent, r.provider_reference,
            u.id AS user_id
     FROM konektag.recharge_projection r
     LEFT JOIN konektag.users u ON u.keycloak_id = r.keycloak_id
     WHERE r.recharge_name = $1 AND r.deleted_at IS NULL`,
    [rechargeName],
  );

  if (!proj) {
    const e = new Error('Recharge introuvable') as any;
    e.statusCode = 404;
    throw e;
  }

  // Idempotence réelle : vérifier qu'un refund Stripe a déjà été émis
  // (ne pas se fier uniquement à recharge_status qui pourrait être 'reversed'
  //  pour une autre raison, ou être incohérent avec la réalité Stripe)
  const { rows: existingRefund } = await pool.query(
    `SELECT payload FROM konektag.admin_actions
     WHERE target_type = 'recharge'
       AND target_id = $1
       AND action_type = 'RECHARGE_REFUND'
       AND payload->>'stripeRefundId' IS NOT NULL
     LIMIT 1`,
    [rechargeName],
  );

  if (existingRefund.length > 0) {
    const existingPayload = typeof existingRefund[0].payload === 'string'
      ? JSON.parse(existingRefund[0].payload) : existingRefund[0].payload;
    return { success: true, rechargeName, stripeRefundId: existingPayload.stripeRefundId, previousStatus: 'reversed' };
  }

  // Si la projection est en 'reversed' mais qu'aucun refund Stripe n'est tracé,
  // c'est une incohérence : on autorise la tentative de refund.
  if (proj.recharge_status !== 'confirmed' && proj.recharge_status !== 'reversed') {
    const e = new Error(`La recharge ${rechargeName} est "${proj.recharge_status}". Seules les recharges confirm\u00E9es peuvent \u00EAtre rembours\u00E9es.`) as any;
    e.statusCode = 409;
    throw e;
  }

  if (proj.payment_method !== 'card') {
    const e = new Error(`La recharge ${rechargeName} utilise "${proj.payment_method}", pas une carte bancaire.`) as any;
    e.statusCode = 400;
    throw e;
  }

  // Extract Stripe PaymentIntent ID
  const paymentIntentId = proj.stripe_payment_intent
    || (proj.provider_reference || '').replace('stripe_pi_', '')
    || null;

  if (!paymentIntentId) {
    const e = new Error('Aucune r\u00E9f\u00E9rence Stripe trouv\u00E9e pour cette recharge.') as any;
    e.statusCode = 400;
    throw e;
  }

  // Call Stripe API to refund
  let stripeRefund: Stripe.Refund;
  try {
    stripeRefund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amount ? Math.round(amount * 100) : undefined,
      reason: 'requested_by_customer',
      metadata: {
        rechargeName,
        adminId,
        correlationId,
      },
    });
  } catch (err: any) {
    console.error(`[refund-stripe] Stripe refund failed for ${paymentIntentId}:`, err.message);
    const e = new Error(`Le remboursement Stripe a \u00E9chou\u00E9 : ${err.message}`) as any;
    e.statusCode = 502;
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL lock_timeout = 5000');

    // Idempotent check inside transaction
    const { rows: existingReversal } = await client.query(
      `SELECT 1 FROM konektag.ledger_entries
       WHERE document_ref = $1
         AND entry_type = 'debit'
         AND document_type = 'Recharge'
         AND is_reversal = true
       LIMIT 1`,
      [rechargeName],
    );

    if (existingReversal.length > 0) {
      await client.query('COMMIT');
      return { success: true, rechargeName, previousStatus: 'reversed' };
    }

    // Write compensating entry: debit with is_reversal=true
    const reversalAmount = amount || Number(proj.credited_amount) || 0;
    await ledgerService.debit({
      clientId: proj.keycloak_id,
      amount: reversalAmount,
      currency: 'XOF',
      documentType: 'Recharge',
      documentRef: rechargeName,
      description: `Remboursement Carte Bancaire — ${reason} (Stripe refund: ${stripeRefund.id})`,
    }, client);

    // Admin action
    await client.query(
      `INSERT INTO konektag.admin_actions
       (admin_id, action_type, target_type, target_id, reason, payload)
       VALUES ($1, 'RECHARGE_REFUND', 'recharge', $2, $3, $4)`,
      [
        adminId,
        rechargeName,
        `Remboursement Stripe: ${reason}`,
        JSON.stringify({
          rechargeName,
          paymentIntentId,
          stripeRefundId: stripeRefund.id,
          refundAmount: reversalAmount,
          reason,
          correlationId,
        }),
      ],
    );

    // Outbox event for projection
    const { rows: [evt] } = await client.query(
       `INSERT INTO konektag.outbox_events
        (correlation_id, causation_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version, payload)
        VALUES ($1, $2, 'Recharge', gen_random_uuid(), $3, 'RechargeReversed', 1, $4)
       RETURNING id`,
      [
        correlationId,
        correlationId,
        rechargeName,
        JSON.stringify({
          rechargeName,
          reason,
          adminId,
          correlationId,
          causationId: correlationId,
        }),
      ],
    );

    await client.query('COMMIT');

    // Notify
    notifyUser(proj.keycloak_id, reversalAmount, rechargeName).catch(err =>
      console.error(`[refund-stripe] Notification failed for ${rechargeName}:`, err.message),
    );

    return {
      success: true,
      rechargeName,
      stripeRefundId: stripeRefund.id,
    };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function notifyUser(keycloakId: string, amount: number, rechargeName: string): Promise<void> {
  const { rows: [u] } = await pool.query(
    `SELECT encrypted_data, locale FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
    [keycloakId],
  );
  if (!u) return;

  const decrypted = JSON.parse(encryptionService.decrypt(u.encrypted_data));
  if (!decrypted.email) return;

  await emailService.sendTemplate('refillAccount', u.locale || 'fr', decrypted.email, {
    firstName: decrypted.firstName || '',
    amount: amount.toString(),
    currency: 'XOF',
    transactionDate: new Date().toLocaleDateString('fr-FR'),
    transactionReference: rechargeName,
    paymentMethod: 'Remboursement Carte Bancaire',
    newBalance: 'Cf. dashboard',
    currentYear: new Date().getFullYear().toString(),
  });
}
