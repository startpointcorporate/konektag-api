import { beginQrPrincipalAttempt, readQrPrincipalReplay, qrPrincipalCommandHash } from '../../../application/services/qr-principal-idempotency-service.ts';
import { completePrincipalAttempt, principalCommandHash, principalAttemptKey, PrincipalReplayConflict } from '../../../application/services/principal-idempotency-service.ts';
import type { RouteHandler } from '../../http';
import { checkUserKycVerified } from '../../../application/services/user-kyc-gate-service.ts';
import crypto from 'node:crypto';
import { sendQrPaymentReceipt } from '../../../application/services/qr-payment-receipt-service.ts';
import { marketingMetricsService } from '../../../application/services/marketing-metrics-service.ts';
import { qrService } from '../../../application/services/qr-service.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { activationChallengeService } from '../../../application/services/activation-challenge-service.ts';
import { verifySignedQrServer } from '../../../application/services/qr-signed-verification-service.ts';
import { consumeLinkAtMerchant } from '../../../application/services/pay/link-k-consumption-service.ts';
import { merchantActivationService } from '../../../application/services/merchant-activation-service.ts';
import { resolveMerchantOperationCurrency, resolveUserOperationCurrency } from '../../../application/services/operation-currency-service.ts';
import { resolvePointsOwner, sendPointsK } from '../../../application/services/pay/points-wallet-service.ts';
import { PointsQuantityError, resolveQrPaymentQuantity } from '../../../application/services/pay/qr-points-quantity.ts';
import { PointsKValuationError } from '../../../application/services/points-k-valuation-service.ts';

export const POST: RouteHandler = async ({ request, cookies, locals }) => {
  try {
    const body = await request.json();
    let {
      qrCodeName, amount, paymentMethod, currency: clientCurrency, merchant, txId,
      walletAmount: _requestedWalletAmount, restantAmount: _restantAmount, authorizationId: _authorizationId, otp: _otp,
    } = body;
    if (!amount) {
      return new Response(JSON.stringify({ error: 'Montant requis' }), { status: 400 });
    }
    if (!qrCodeName) {
      return new Response(JSON.stringify({ error: 'qrCodeName requis' }), { status: 400 });
    }

    const user = locals.user;
    if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
    const attemptKey = principalAttemptKey(txId || qrCodeName);
    const legacyCommandHash = principalCommandHash([body.signedQrToken || body.qrToken, Number(amount), Number(body.expectedQuantityK), clientCurrency || null]);
    const keycloakId = user.keycloak_id;
    const clientEmail = user.email || keycloakId;
    const { rows: [payerUser] } = await pool.query<{ id: string; username: string | null }>(
      `SELECT id, username FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [keycloakId],
    );
    if (!payerUser) return new Response(JSON.stringify({ error: 'Utilisateur introuvable' }), { status: 401 });
    const commandHash = qrPrincipalCommandHash(payerUser.id, legacyCommandHash);
    const replayContract = {payerId:payerUser.id,token:body.signedQrToken || body.qrToken,amount:Number(amount),quantity:Number(body.expectedQuantityK),currency:clientCurrency};
    const replayClient = await pool.connect();
    try {
      await replayClient.query('BEGIN');
      const previousResponse = await readQrPrincipalReplay(replayClient, user.id, attemptKey, commandHash, legacyCommandHash, replayContract);
      await replayClient.query('COMMIT');
      if (previousResponse) return previousResponse;
    } catch (error) {
      await replayClient.query('ROLLBACK');
      throw error;
    } finally { replayClient.release(); }


    const totalAmt = Number(amount);
    if (!Number.isSafeInteger(totalAmt) || totalAmt <= 0) {
      return new Response(JSON.stringify({ error: 'Montant invalide' }), { status: 400 });
    }

    const signedQrToken = body.signedQrToken || body.qrToken;
    if (typeof signedQrToken !== 'string' || signedQrToken.split('./index.ts').length !== 3) {
      return new Response(JSON.stringify({ error: 'SIGNED_QR_REQUIRED', code: 'QRI-005' }), { status: 409 });
    }
    let signedPayload: any;
    try {
      signedPayload = await verifySignedQrServer(signedQrToken);
    } catch (error) {
      if (error instanceof Error && error.message === 'QR_CONTRACT_OUTDATED') {
        return new Response(JSON.stringify({ error: 'QR_CONTRACT_OUTDATED', code: 'QRI-005' }), { status: 409 });
      }
      return new Response(JSON.stringify({ error: 'SIGNED_QR_INVALID', code: 'QRI-005' }), { status: 409 });
    }
    qrCodeName = signedPayload.requestId;
    const tokenHash = crypto.createHash('sha256').update(signedQrToken).digest('hex');
    const { rows: [persistedIntent] } = await pool.query<{
      id: string; merchant_profile_id: string | null; owner_user_id: string | null; usage_unique: boolean;
      amount: string | number; currency: string; qr_type: 'Static' | 'Dynamic';
    }>(
        `SELECT id, merchant_profile_id, owner_user_id, amount, currency, qr_type, usage_unique
         FROM konektag.checkout_intents
         WHERE public_id = $1 AND token_hash = $2 AND source_type = 'qr'
        `, [qrCodeName, tokenHash]);
    if (!persistedIntent || (persistedIntent.merchant_profile_id == null) === (persistedIntent.owner_user_id == null)) {
      return new Response(JSON.stringify({ error: 'SIGNED_QR_TARGET_MISMATCH', code: 'QRI-005' }), { status: 409 });
    }

    let qrDoc: Awaited<ReturnType<typeof qrService.getQR>>;
    try {
      qrDoc = await qrService.getQR(qrCodeName);
    } catch {
      return new Response(JSON.stringify({ error: 'QR_NOT_FOUND', code: 'QRI-001' }), { status: 404 });
    }

    // 1. Déterminer le destinataire (avant KYB/eligibility)
    let merchantEtablissement = '';
    let qrPayloadCurrency: string | null = null;

    merchantEtablissement = qrDoc.etablissement || '';
    if (qrDoc.qr_data) {
      try { qrPayloadCurrency = JSON.parse(qrDoc.qr_data).currency || null; } catch {}
    }

    // Resolve and bind the merchant before exposing checkout state. The later
    // conditional UPDATE remains the atomic one-time-use claim.
    let resolvedMerchantId: string | null = null;
    if (persistedIntent.merchant_profile_id) {
      resolvedMerchantId = await qrService.resolveMerchantFromEtablissement(
        merchantEtablissement,
      ).catch(() => null);
      if (!resolvedMerchantId || persistedIntent.merchant_profile_id !== resolvedMerchantId) {
        return new Response(JSON.stringify({ error: 'MERCHANT_NOT_RESOLVED', code: 'QRI-001' }), { status: 403 });
      }
    }

    // The checkout owner is authoritative. Browser and embedded payload values
    // may only confirm that currency, never select or convert it.
    const operationContext = resolvedMerchantId
      ? await resolveMerchantOperationCurrency(pool, resolvedMerchantId, qrDoc.currency)
      : await resolveUserOperationCurrency(pool, persistedIntent.owner_user_id!, persistedIntent.currency);
    const transactionCurrency = operationContext.currency;
    if ((clientCurrency && String(clientCurrency).toUpperCase() !== transactionCurrency)
      || (qrPayloadCurrency && String(qrPayloadCurrency).toUpperCase() !== transactionCurrency)) {
      return new Response(JSON.stringify({ error: 'OPERATION_CURRENCY_MISMATCH' }), { status: 409 });
    }

    // Validate the GAP-004 signed target before eligibility or payment side effects.
    if (signedPayload.currency !== transactionCurrency
      || signedPayload.variableAmount !== (persistedIntent.qr_type === 'Static' && Number(persistedIntent.amount) === 0)
      || (signedPayload.beneficiaryType === 'MERCHANT' && signedPayload.beneficiaryId !== resolvedMerchantId)
      || (signedPayload.beneficiaryType === 'USER' && signedPayload.beneficiaryId !== persistedIntent.owner_user_id)) {
      return new Response(JSON.stringify({ error: 'SIGNED_QR_TARGET_MISMATCH', code: 'QRI-005' }), { status: 409 });
    }

    // USER QR/Link is a pure K -> K movement: the payer chooses quantityK
    // and local currencies are display-only. MERCHANT QR remains a local
    // monetary payment whose K quantity is valued authoritatively by the server.
    let quantityK: number;
    let quantityValuationProofHash = '';
    try {
      if (signedPayload.beneficiaryType === 'USER') {
        quantityK = Number(body.expectedQuantityK);
        if (!Number.isSafeInteger(quantityK) || quantityK <= 0) {
          return new Response(JSON.stringify({ error: 'INVALID_POINTS_QUANTITY' }), { status: 400 });
        }
        if (!signedPayload.variableAmount && Number(signedPayload.quantityK) !== quantityK) {
          return new Response(JSON.stringify({ error: 'SIGNED_QR_QUANTITY_MISMATCH', code: 'QRI-005' }), { status: 409 });
        }
      } else {
        const valuation = await resolveQrPaymentQuantity(pool, signedPayload, {
          amountMinor: totalAmt, expectedQuantityK: body.expectedQuantityK,
        });
        quantityK = valuation.quantityK;
        quantityValuationProofHash = valuation.proofHash;
      }
    } catch (error) {
      if (error instanceof PointsQuantityError) {
        return new Response(JSON.stringify({ error: error.code, quotedQuantityK: error.quotedQuantityK }), { status: 409 });
      }
      if (error instanceof PointsKValuationError) {
        return new Response(JSON.stringify({ error: error.code }), { status: 503 });
      }
      throw error;
    }

    // ── KYB + payer KYC checks (merchant payments only) ──
    if (resolvedMerchantId) {
      const activation = await merchantActivationService.requireMerchantApproved(resolvedMerchantId!);
      if (!activation.ok) {
        return new Response(JSON.stringify({
          error: 'MERCHANT_NOT_ACTIVATED',
          code: 'QRI-001',
          reason: activation.error,
        }), { status: 403 });
      }
      const payerKyc = await checkUserKycVerified(pool, payerUser.id);
      if (!payerKyc.verified) {
        return new Response(JSON.stringify({
          error: 'USER_KYC_REQUIRED',
          code: 'QRI-KYC-001',
          state: payerKyc.state,
        }), { status: 403 });
      }
    }

    // Internal-network QR Pay follows the same K-consumption boundary as Link Pay.
    // Country is commercial/payment evidence only; it must not create a financial corridor.
    const merchantCountryCode = operationContext.country;

    // 7. Résoudre le destinataire
    let recipientPartyId: string | null = null;
    // The signed QR displayName is authenticated by CORE-02 and bound to the merchant certificate.
    // Never expose the internal merchant UUID as the receipt display name.
    let recipientDisplay: string = signedPayload.displayName || merchantEtablissement || merchant || '';
    let recipientUserKeycloakId: string | null = null;
    let recipientUserCountry: string | null = null;

    if (persistedIntent.owner_user_id) {
      // QR personnel : destinataire = utilisateur
      const { rows: [recipientUser] } = await pool.query(
        `SELECT id, keycloak_id, username, country FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
        [persistedIntent.owner_user_id],
      );
      if (recipientUser) {
        recipientUserKeycloakId = recipientUser.keycloak_id;
        recipientUserCountry = recipientUser.country;
        recipientDisplay = recipientUser.username || persistedIntent.owner_user_id;
        const { rows: [rp] } = await pool.query(
          `SELECT id FROM konektag.parties WHERE keycloak_id = $1 AND is_active = true`,
          [recipientUser.keycloak_id],
        );
        if (rp) recipientPartyId = rp.id;
      }
    } else {
      // QR commerçant
      // ── Anti-self-payment (P07) ──
      const { rows: [merchantOwner] } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [resolvedMerchantId],
      );
      if (merchantOwner?.user_id === payerUser.id) {
        return new Response(JSON.stringify({ error: 'SELF_PAYMENT_FORBIDDEN', code: 'QRI-006' }), { status: 403 });
      }
    }

    if (!resolvedMerchantId && !recipientPartyId) {
      return new Response(JSON.stringify({ error: 'Destinataire introuvable' }), { status: 400 });
    }
    if (!resolvedMerchantId && persistedIntent.owner_user_id === payerUser.id) {
      return new Response(JSON.stringify({ error: 'SELF_PAYMENT_FORBIDDEN', code: 'QRI-006' }), { status: 403 });
    }

    // Bounded identities; the separate attempt record binds the immutable command.
    const paymentRef = qrCodeName;
    const paymentAttemptId = attemptKey;
    const idempotencyKey = `QR:${principalCommandHash([user.id, signedPayload.beneficiaryType, signedPayload.beneficiaryId, quantityK, totalAmt, transactionCurrency, paymentAttemptId])}`;
    const client = await pool.connect();
    let result: { success: boolean; financialTransactionId?: string; kOperationId?: string; merchantSaleId?: string; error?: string };
    try {
      await client.query('BEGIN');
      const attempt = await beginQrPrincipalAttempt(client, user.id, attemptKey, commandHash, legacyCommandHash, replayContract);
      if (attempt.replay) { await client.query('COMMIT'); return attempt.replay; }

      // A competing confirmation may commit after the early replay lookup.
      // Resolve the acquired result under the identity lock before rejecting a used QR.
      if (qrDoc?.status === 'Expired') {
        await client.query('ROLLBACK');
        return new Response(JSON.stringify({ error: 'QR_EXPIRED', code: 'QRI-002' }), { status: 409 });
      }
      if (qrDoc && qrDoc.status !== 'Active') {
        await client.query('ROLLBACK');
        return new Response(JSON.stringify({ error: 'QR_ALREADY_USED', code: 'QRI-003' }), { status: 409 });
      }

      if (signedPayload.singleUse) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['offline-qr:' + signedPayload.requestId]);
        const offlineClaim = await client.query('SELECT 1 FROM konektag.core_payment_qr_claims WHERE request_id=$1', [signedPayload.requestId]);
        if (offlineClaim.rowCount) throw new Error('QR_ALREADY_USED');
      }
      const { rows: [lockedIntent] } = await client.query(
        `SELECT id, merchant_profile_id, owner_user_id, amount, currency, qr_type, status, expiration, usage_unique
         FROM konektag.checkout_intents
         WHERE public_id = $1 AND token_hash = $2 AND source_type = 'qr'
         FOR UPDATE`, [qrCodeName, tokenHash]);
      if (!lockedIntent || (lockedIntent.merchant_profile_id == null) === (lockedIntent.owner_user_id == null)
        || lockedIntent.currency !== transactionCurrency
        || lockedIntent.merchant_profile_id !== persistedIntent.merchant_profile_id
        || lockedIntent.owner_user_id !== persistedIntent.owner_user_id) {
        await client.query('ROLLBACK');
        return new Response(JSON.stringify({ error: 'SIGNED_QR_TARGET_MISMATCH', code: 'QRI-005' }), { status: 409 });
      }
      const variableAmount = lockedIntent.qr_type === 'Static' && Number(lockedIntent.amount) === 0;
      if ((!variableAmount && Number(lockedIntent.amount) !== totalAmt)
        || variableAmount !== signedPayload.variableAmount) {
        await client.query('ROLLBACK');
        return new Response(JSON.stringify({ error: 'SIGNED_QR_AMOUNT_MISMATCH', code: 'QRI-005' }), { status: 409 });
      }

      const claimed = lockedIntent.usage_unique ? await client.query(
        `UPDATE konektag.checkout_intents
         SET status = 'PROCESSING', updated_at = now(), version = version + 1
         WHERE id = $1 AND status = 'ISSUED' AND expiration > now()
         RETURNING id`,
        [lockedIntent.id],
      ) : { rowCount: 1 };
      if (!claimed.rowCount) {
        await client.query('ROLLBACK');
        return new Response(JSON.stringify({ error: 'QR_ALREADY_USED', code: 'QRI-003' }), { status: 409 });
      }

      const coreRequestKey = `QR:${signedPayload.requestId}:${paymentAttemptId}`;
      const coreHash = crypto.createHash('sha256').update(signedQrToken).digest('hex');
      const { rows: [coreTransaction] } = await client.query<{ id: string }>(
        `INSERT INTO konektag.core_transactions
          (merchant_profile_id, customer_user_id, kind, state, currency, total_minor,
           request_key, request_hash, note)
         VALUES ($1, $2, 'REQUEST', 'CREATED', $3, $4, $5, $6, $7)
         ON CONFLICT (customer_user_id, request_key) WHERE request_key LIKE 'QR:%' DO UPDATE
           SET updated_at = now()
         RETURNING id`,
        [resolvedMerchantId, payerUser.id, transactionCurrency, totalAmt, coreRequestKey,
          coreHash, `QR Pay ${signedPayload.beneficiaryType}:${signedPayload.beneficiaryId}`],
      );
      if (!coreTransaction?.id) throw new Error('CORE_TRANSACTION_MISSING');

      result = lockedIntent.merchant_profile_id
        ? await consumeLinkAtMerchant({
        idempotencyKey,
        userId: payerUser.id,
        merchantProfileId: resolvedMerchantId!,
        amount: totalAmt,
        quantityK,
        quantityValuationProofHash,
        currency: transactionCurrency,
        merchantSaleRef: `SALE-${principalCommandHash([user.id, signedPayload.requestId, paymentAttemptId])}`,
        rail: 'payment_link',
      }, client)
        : await (async () => {
          // Resolve the payer country from the authenticated persisted user, never the request.
          const payerCountry = await resolveUserOperationCurrency(client, payerUser.id);
          const { rows: [profile] } = await client.query<{ id: string }>(
            `SELECT id FROM konektag.regulatory_profiles
             WHERE authorized_operation='qr_payment' AND country_of_origin=$1 AND country_of_destination=$2
               AND status='APPROVED' AND deleted_at IS NULL LIMIT 1`,
            [payerCountry.country, merchantCountryCode],
          );
          const regulatoryProfileId = profile?.id;
          if (!regulatoryProfileId) throw new Error('QR_REGULATORY_PROFILE_REQUIRED');
          const payerPartyId = await resolvePointsOwner(client, payerUser.id);
          const recipientPartyId = await resolvePointsOwner(client, persistedIntent.owner_user_id!, true);
          const financialTransactionId = await sendPointsK(client, {
            payerPartyId, recipientPartyId, quantity: quantityK, operationKey: idempotencyKey,
            corridorId: `${payerCountry.country}-${merchantCountryCode}`,
            regulatoryProfileId,
          });
          return { success: true, financialTransactionId };
        })();
      if (!result.success) throw new Error(result.error || 'Échec de la transaction');
      const operationId = result.kOperationId || result.financialTransactionId;
      if (!operationId) throw new Error('QR_OPERATION_MISSING');
      await client.query(
        `UPDATE konektag.core_transactions
         SET state = 'CLOSED', state_version = state_version + 1, updated_at = now()
         WHERE id = $1 AND state = 'CREATED'`, [coreTransaction.id],
      );
      const consumed = lockedIntent.usage_unique ? await client.query(
        `UPDATE konektag.checkout_intents
         SET status = 'CONSUMED', payer_user_id = $1,
             financial_transaction_id = $2, operation_id = $3, core_transaction_id = $4,
             consumed_at = now(), updated_at = now(), version = version + 1
         WHERE public_id = $5 AND source_type = 'qr' AND status = 'PROCESSING'
         RETURNING id`, [payerUser.id, result.financialTransactionId ?? null, operationId, coreTransaction.id, qrCodeName]) : { rowCount: 1 };
      if (!consumed.rowCount) throw new Error('QR_COMPLETION_FAILED');
      await completePrincipalAttempt(client, attempt.id, 200, {success:true, kOperationId:result.kOperationId, financialTransactionId:result.financialTransactionId, currency:transactionCurrency});
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (persistedIntent.owner_user_id) {
      await activationChallengeService.recordActivity({
        userId: persistedIntent.owner_user_id,
        financialTransactionId: result.financialTransactionId,
        sourceType: 'qr_personal',
        sourceId: paymentRef,
        metricType: 'QrPaymentReceived',
        amount: totalAmt,
        currency: transactionCurrency,
        countryCode: recipientUserCountry,
        metadata: { payerUserId: payerUser.id },
      }).catch(error => console.error(`[activation] Personal QR projection failed for ${paymentRef}:`, error.message));
    } else {
      const { rows: merchants } = await pool.query<{ country: string | null }>(
        `SELECT country FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`,
        [resolvedMerchantId],
      );
      await activationChallengeService.recordActivity({
        userId: payerUser.id,
        financialTransactionId: result.financialTransactionId,
        sourceType: 'merchant_payment',
        sourceId: paymentRef,
        metricType: 'MerchantPayment',
        amount: totalAmt,
        currency: transactionCurrency,
        countryCode: merchants[0]?.country ?? null,
        metadata: { merchantProfileId: resolvedMerchantId },
      }).catch(error => console.error(`[activation] Merchant QR projection failed for ${paymentRef}:`, error.message));
    }

    // 9. Mise à jour de la projection marketing
    try {
      const { rows: [u] } = await pool.query(
        `SELECT id FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
        [keycloakId],
      );
      if (u) {
        await marketingMetricsService.refresh(u.id, keycloakId);
      }
    } catch (e: any) {
      console.error('[QR] Marketing metrics refresh failed:', e.message);
    }

    // Optional receipt, exactly like Link Pay: only after the payment commit.
    // Delivery metadata stays in the header; the committed payment body is replayable.
    const receiptSent = await sendQrPaymentReceipt({
      email: user.email || undefined,
      qrCodeName: paymentRef,
      userId: payerUser.id,
      firstName: 'firstName' in user && typeof user.firstName==='string' ? user.firstName : undefined,
      locale: user.locale,
      payment: {
        merchantName: recipientDisplay,
        amount: totalAmt,
        currency: transactionCurrency,
        quantityK,
        reference: signedPayload.reference || paymentRef,
      },
      origin: process.env.PUBLIC_SITE_URL || new URL(request.url).origin,
    });

    return new Response(JSON.stringify({
      success: true,
      financialTransactionId: result.financialTransactionId,
      kOperationId: result.kOperationId,
      currency: transactionCurrency,
    }), { status: 200, headers: { 'X-QR-Receipt-Sent': receiptSent ? 'true' : 'false' } });

  } catch (err: any) {
    console.error('[QR-confirm] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: err instanceof PrincipalReplayConflict ? 409 : 400 });
  }
};

async function getOrCreateParty(keycloakId: string, email: string): Promise<{ id: string }> {
  const { rows } = await pool.query(
    `SELECT id FROM konektag.parties WHERE keycloak_id = $1 AND is_active = true`,
    [keycloakId],
  );
  if (rows.length > 0) return rows[0];
  const { rows: [party] } = await pool.query(
    `INSERT INTO konektag.parties (party_type, keycloak_id, display_name, email)
     VALUES ('individual', $1, $2, $3) RETURNING id`,
    [keycloakId, email.split('@')[0] || keycloakId, email],
  );
  return party;
}
