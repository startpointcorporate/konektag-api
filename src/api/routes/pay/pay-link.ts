import { beginPrincipalAttempt, completePrincipalAttempt, readPrincipalReplay, principalCommandHash, principalAttemptKey, PrincipalReplayConflict } from '../../../application/services/principal-idempotency-service.ts';
import type { RouteHandler } from '../../http';
import { sendLinkPaymentReceipt } from '../../../application/services/link-payment-receipt-service.ts';
import { merchantActivationService } from '../../../application/services/merchant-activation-service.ts';
import { paymentLinkService } from '../../../application/services/payment-link-service.ts';
import { consumeLinkAtMerchant } from '../../../application/services/pay/link-k-consumption-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { checkUserKycVerified } from '../../../application/services/user-kyc-gate-service.ts';
import {markSocialBoostPaid} from '../../../application/services/merchant-social-boost-service.ts';
import { networkLinkService } from '../../../application/link-pay/network-link-service.ts';
import { payNetworkLink } from '../../../application/link-pay/network-payment.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const { slug, payer_email, transaction_id } = await request.json();
    if (!slug) return new Response(JSON.stringify({ error: 'slug required' }), { status: 400 });
    const user = (locals as any).user;
    if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

    const attemptKey = principalAttemptKey(slug);
    const commandHash = principalCommandHash([slug, payer_email || null, transaction_id || null]);
    const previousResponse = await readPrincipalReplay(pool, user.id, 'LINK_PAYMENT', attemptKey, commandHash);
    if (previousResponse) return previousResponse;
    // Network links (Frappe site collected through its network) never read a merchant profile.
    const networkLink = await networkLinkService.getBySlug(slug);
    if (networkLink) return await payNetworkLink({ link: networkLink, slug, user, attemptKey, commandHash,
      payerIdentity: payer_email || user.email || null, externalTransactionId: transaction_id || null });
    const link = await paymentLinkService.get(slug);
    if (!link || link.status !== 'Active') {
      // A concurrent identical request may have committed between the first replay read and this read.
      const committedReplay = await readPrincipalReplay(pool, user.id, 'LINK_PAYMENT', attemptKey, commandHash);
      if (committedReplay) return committedReplay;
      return new Response(JSON.stringify({ error: 'Lien introuvable, expire ou deja utilise' }), { status: 404 });
    }
    const { rows: [merchantOwner] } = await pool.query(
      'SELECT user_id FROM konektag.merchant_profiles WHERE id=$1', [link.merchant]);
    if (merchantOwner?.user_id === user.id) {
      return new Response(JSON.stringify({ error: 'SELF_PAYMENT_FORBIDDEN' }), { status: 403 });
    }
    // Only a server-valued link proves the Points K quantity it debits.
    if (!link.valuation) return new Response(JSON.stringify({ error: 'PAYMENT_LINK_CONTRACT_OUTDATED' }), { status: 409 });
    const activation = await merchantActivationService.requireMerchantApproved(link.merchant);
    if (!activation.ok) return new Response(JSON.stringify({ error: activation.error, code: 'LINK-001' }), { status: 403 });
    const payerKyc = await checkUserKycVerified(pool, user.id);
    if (!payerKyc.verified) return new Response(JSON.stringify({
      error: 'USER_KYC_REQUIRED', code: 'LINK-KYC-001', state: payerKyc.state,
    }), { status: 403 });
    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof consumeLinkAtMerchant>>;
    try {
      await client.query('BEGIN');
      const attempt = await beginPrincipalAttempt(client, user.id, 'LINK_PAYMENT', attemptKey, commandHash);
      if (attempt.replay) { await client.query('COMMIT'); return attempt.replay; }

      if (!await paymentLinkService.claim(slug, client)) {
        await client.query('ROLLBACK');
        return new Response(JSON.stringify({ error: 'Lien deja utilise' }), { status: 409 });
      }
      result = await consumeLinkAtMerchant({
        idempotencyKey: `LINK-${slug}`,
        userId: user.id, merchantProfileId: link.merchant, amount: link.amount, quantityK: link.quantityK, quantityValuationProofHash: link.valuation.proofHash,
        currency: link.currency, merchantSaleRef: `LINK-${slug}`, rail: 'payment_link',
      }, client);
      const completed = await paymentLinkService.complete(slug, {
        payerUserId: user.id,
        payerIdentity: payer_email || user.email || null,
        externalTransactionId: transaction_id || null,
        kOperationId: result.kOperationId,
      }, client);
      if (!completed) throw new Error('LINK_COMPLETION_FAILED');
      await completePrincipalAttempt(client, attempt.id, 201, { success:true, message:'Paiement confirme', kOperationId:result.kOperationId });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const payment = { merchantName: link.etablissement || 'Commerçant', amount: link.amount,
      currency: link.currency, quantityK: link.quantityK, reference: link.reference || `LINK-${slug}` };
    if(link.reference?.startsWith('BOOST:')) await markSocialBoostPaid(link.url_slug);
    const receiptSent = await sendLinkPaymentReceipt({ email: payer_email, slug, userId: user.id,
      firstName: user.firstName, locale: user.locale, payment,
      origin: process.env.PUBLIC_SITE_URL || new URL(request.url).origin });
    return new Response(JSON.stringify({ success: true, message: 'Paiement confirme',
      kOperationId: result.kOperationId }), { status: 201,
      headers: { 'X-Link-Receipt-Sent': receiptSent ? 'true' : 'false' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: err instanceof PrincipalReplayConflict ? 409 : 400 });
  }
};
