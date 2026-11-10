import pool from '../../infrastructure/database/pool.ts';
import { PointsKValuationSchema } from '../../domain/points-k-valuation.ts';
import { beginPrincipalAttempt, completePrincipalAttempt } from '../services/principal-idempotency-service.ts';
import { paymentLinkService } from '../services/payment-link-service.ts';
import { checkUserKycVerified } from '../services/user-kyc-gate-service.ts';
import { beneficiaryTerms, LinkPaySiteError } from './frappe-site-routing.ts';
import { networkLinkService } from './network-link-service.ts';
import { siteWebhookService } from './site-webhook-service.ts';
import { sendLinkPaymentReceipt } from '../services/link-payment-receipt-service.ts';

type NetworkLink = NonNullable<Awaited<ReturnType<typeof networkLinkService.getBySlug>>>;
const reply = (body: unknown, status: number) => Response.json(body, { status });

/**
 * Client confirmation of a network link. The approval is read again on the network site (a revoked
 * beneficiary is never paid); the fee rule stays the one frozen at issuance. Debit, transaction,
 * webhook queue and link consumption commit together; webhooks are sent after the commit.
 */
export async function payNetworkLink(input: { link: NetworkLink; slug: string; user: { id: string };
  attemptKey: string; commandHash: string; payerIdentity: string | null; externalTransactionId: string | null;
  receipt?: { email?: string; firstName?: string; locale?: string; origin: string } }) {
  const { link, slug, user } = input;
  if (link.status !== 'Active') return reply({ error: 'Lien introuvable, expire ou deja utilise' }, 404);
  const valuation = PointsKValuationSchema.safeParse(link.valuation);
  if (!valuation.success || valuation.data.quantityK !== link.quantityK || valuation.data.sourceAmountMinor !== link.amount
    || valuation.data.sourceCurrency !== link.currency) return reply({ error: 'PAYMENT_LINK_CONTRACT_OUTDATED' }, 409);
  try {
    await beneficiaryTerms(link.network.site, link.beneficiary.site);
  } catch (error) {
    if (error instanceof LinkPaySiteError && error.status === 503) return reply({ error: error.code }, 503);
    return reply({ error: 'BENEFICIARY_NOT_APPROVED', code: 'LINK-001' }, 403);
  }
  const payerKyc = await checkUserKycVerified(pool, user.id);
  if (!payerKyc.verified) return reply({ error: 'USER_KYC_REQUIRED', code: 'LINK-KYC-001', state: payerKyc.state }, 403);
  const client = await pool.connect();
  let result: { kOperationId: string; transactionId: string };
  try {
    await client.query('BEGIN');
    const attempt = await beginPrincipalAttempt(client, user.id, 'LINK_PAYMENT', input.attemptKey, input.commandHash);
    if (attempt.replay) { await client.query('COMMIT'); return attempt.replay; }
    if (!await paymentLinkService.claim(slug, client)) {
      await client.query('ROLLBACK');
      return reply({ error: 'Lien deja utilise' }, 409);
    }
    result = await networkLinkService.pay(client, { slug, checkoutIntentId: link.checkoutIntentId, userId: user.id,
      amountMinor: link.amount, quantityK: link.quantityK, currency: link.currency });
    if (!await paymentLinkService.complete(slug, { payerUserId: user.id, payerIdentity: input.payerIdentity,
      externalTransactionId: input.externalTransactionId, kOperationId: result.kOperationId }, client))
      throw new Error('LINK_COMPLETION_FAILED');
    await completePrincipalAttempt(client, attempt.id, 201, { success: true, message: 'Paiement confirme',
      kOperationId: result.kOperationId });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // Network first; the beneficiary is released by the network's acknowledgement. The worker retries.
  void pool.query(`SELECT id FROM konektag.link_pay_site_webhooks WHERE transaction_id = $1 AND status = 'pending'`,
    [result.transactionId]).then(({ rows }) => Promise.all(rows.map((row: any) => siteWebhookService.deliver(row.id))))
    .catch(() => undefined);
  // Optional receipt, strictly after commit; it writes no payment state.
  const receiptSent = input.receipt ? await sendLinkPaymentReceipt({ email: input.receipt.email, slug, userId: user.id,
    firstName: input.receipt.firstName, locale: input.receipt.locale, origin: input.receipt.origin,
    payment: { merchantName: link.beneficiary.name, amount: link.amount, currency: link.currency,
      quantityK: link.quantityK, reference: link.reference } }) : false;
  return Response.json({ success: true, message: 'Paiement confirme', kOperationId: result.kOperationId },
    { status: 201, headers: { 'X-Link-Receipt-Sent': receiptSent ? 'true' : 'false' } });
}
