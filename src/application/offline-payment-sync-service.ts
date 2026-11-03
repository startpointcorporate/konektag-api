import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import pool from '../infrastructure/database/pool.ts';
import { BatchSchema, ReceiptSchema, OrderSchema, verifyProof, type Roots, type Proof } from './shared/offline-pay/protocol.ts';
import { sha256, verifyJws } from './shared/core02/crypto.ts';
import { verifyAuthority } from './shared/core02/qr.ts';
import { CertificateSchema } from './shared/core02/contracts.ts';
import { signAuthority } from './core02-identity-service.ts';
import { attachOfflineEvidence, serverEurMinor } from './core-offline-service.ts';
import { consumptionService } from './services/consumption-service.ts';
import { resolveMerchantOperationCurrency } from './services/operation-currency-service.ts';
import { PointsKValuationError, valuePointsK } from './services/points-k-valuation-service.ts';
import { PointsQuantityError, verifyFixedQrQuantity } from './services/pay/qr-points-quantity.ts';

async function roots(): Promise<Roots> {
  const result: Roots = Object.create(null);
  const { PublicKeySchema } = await import('./shared/core02/contracts.ts');
  for (const [kid, jwk] of Object.entries(JSON.parse(process.env.PUBLIC_CORE02_TRUST_ROOTS || '{}'))) {
    result[kid] = await crypto.subtle.importKey('jwk', PublicKeySchema.parse(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  if (!Object.keys(result).length) throw new Error('AUTHORITY_UNAVAILABLE');
  return result;
}

async function link(client: PoolClient, device: string, counter: number, digest: string, previous: string | null, orderHash: string) {
  await client.query(`INSERT INTO konektag.core_payment_links(device_id,local_counter,digest,previous_hash,order_hash)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [device, counter, digest, previous, orderHash]);
  const { rows } = await client.query(`SELECT local_counter::text,digest,previous_hash FROM konektag.core_payment_links
    WHERE device_id=$1 AND local_counter<=$2 ORDER BY local_counter,digest`, [device, counter]);
  let expected = 0, previousHash: string | null = null;
  for (const row of rows) {
    if (Number(row.local_counter) !== expected || row.previous_hash !== previousHash) return false;
    expected++; previousHash = row.digest;
  }
  return expected === counter + 1 && previousHash === digest;
}

async function decide(client: PoolClient, verified: Awaited<ReturnType<typeof verifyProof>>, proof: Proof,
  orderHash: string, state: 'SETTLED' | 'REJECTED' | 'REQUIRES_REVIEW', reason: string,
  transactionId: string | null = null, financialTransactionId: string | null = null) {
  const { order, envelope } = verified;
  const { rows: [row] } = await client.query(`INSERT INTO konektag.core_payment_decisions
    (order_hash,operation_id,device_id,authorization_id,state,receipt,transaction_id)
    VALUES($1,$2,$3,$4,$5,'',$6) ON CONFLICT(order_hash) DO UPDATE SET state=EXCLUDED.state,transaction_id=EXCLUDED.transaction_id
    RETURNING decision_order::text`, [orderHash, order.operationId, order.deviceId, envelope.authorizationId, state, transactionId]);
  const payload = ReceiptSchema.parse({ version: 1, operationId: order.operationId, orderHash, state, reason,
    decidedAt: Math.floor(Date.now()/1000), decisionOrder: Number(row.decision_order), transactionId, financialTransactionId });
  const receipt = await signAuthority(payload, 'KTG-OFFRESULT1');
  await client.query(`UPDATE konektag.core_payment_decisions SET receipt=$2 WHERE order_hash=$1`, [orderHash, receipt]);
  return receipt;
}

async function apply(client: PoolClient, userId: string, submitter: string, original: Awaited<ReturnType<typeof verifyProof>>, trust: Roots) {
  let verified = original, proof = original.proof;
  const { order, envelope } = original, orderHash = await sha256(proof.order);
  if (!((original.customer.ownerUserId === userId && original.customer.deviceId === submitter) ||
    (original.merchant.ownerUserId === userId && original.merchant.deviceId === submitter))) throw new Error('SUBMITTER_DENIED');
  // Retain both copies, including counter branches, without modifying an earlier proof.
  const proofHash = await sha256(proof);
  await client.query(`INSERT INTO konektag.core_payment_submissions(proof_hash,order_hash,submitter_device_id,proof)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [proofHash, orderHash, submitter, proof]);
  const { rows: [existing] } = await client.query(`SELECT * FROM konektag.core_payment_decisions WHERE device_id=$1 AND operation_id=$2`, [order.deviceId, order.operationId]);
  if (existing && existing.order_hash !== orderHash) {
    return signAuthority(ReceiptSchema.parse({ version: 1, operationId: order.operationId, orderHash,
      state: 'REQUIRES_REVIEW', reason: 'OPERATION_BRANCH', decidedAt: Math.floor(Date.now()/1000),
      decisionOrder: Number(existing.decision_order), transactionId: null, financialTransactionId: null }), 'KTG-OFFRESULT1');
  }
  // An authoritative terminal decision survives certificate expiry and later revocation.
  if (existing && ['SETTLED', 'REJECTED'].includes(existing.state)) return existing.receipt;
  if (!proof.acceptance) {
    const { rows: copies } = await client.query(`SELECT proof FROM konektag.core_payment_submissions
      WHERE order_hash=$1 AND proof->>'acceptance' IS NOT NULL ORDER BY received_at`, [orderHash]);
    if (copies.length) {
      proof = copies[0].proof;
      verified = await verifyProof(proof, trust, Math.floor(Date.now()/1000), true);
    }
  }
  const review = (reason: string) => decide(client, verified, proof, orderHash, 'REQUIRES_REVIEW', reason);
  if (verified.merchantOrder && Math.floor(Date.now() / 1000) >= verified.merchantOrder.expiresAt) return review('ORDER_EXPIRED');
  const registered = await client.query(`SELECT c.token FROM konektag.core_device_certificates c
    JOIN konektag.core_device_keys k ON k.key_id=c.key_id
    JOIN konektag.core_offline_devices d ON d.id=k.device_id
    WHERE c.token=ANY($1::text[]) AND d.state='ACTIVE' AND k.state IN ('ACTIVE','RETIRING')
      AND (k.retire_at IS NULL OR k.retire_at>now())
      AND NOT EXISTS(SELECT 1 FROM konektag.core_key_revocations r WHERE r.key_id=k.key_id OR r.device_id=d.id)
    FOR SHARE OF c,k,d`, [[proof.customerCertificate, proof.merchantCertificate]]);
  if (registered.rowCount !== 2) return review('DEVICE_REVOKED_OR_UNREGISTERED');
  const { rows: [authorization] } = await client.query(`SELECT a.*, e.token FROM konektag.core_offline_authorizations a
    JOIN konektag.core_payment_envelopes e ON e.authorization_id=a.id
    WHERE a.id=$1 AND a.device_id=$2 AND a.owner_user_id=$3 FOR UPDATE OF a`, [envelope.authorizationId, order.deviceId, order.ownerUserId]);
  if (!authorization || authorization.token !== proof.envelope) throw new Error('ENVELOPE_UNREGISTERED');
  if (authorization.server_decision !== 'APPROVED' || authorization.reference_status !== 'VERIFIED') return review('AUTHORIZATION_REVOKED');
  const customerChain = await link(client, order.deviceId, order.localCounter, orderHash, order.previousHash, orderHash);
  const ack = verified.acceptance;
  const merchantChain = verified.merchantOrder ? true : (ack ? await link(client, ack.deviceId, ack.localCounter, await sha256(proof.acceptance), ack.previousHash, orderHash) : false);
  if (!ack && !verified.merchantOrder) return review('MERCHANT_RECEIPT_MISSING');
  if (!customerChain || !merchantChain) return review('COUNTER_BRANCH_OR_CHAIN_GAP');
  if (new Date(authorization.expires_at).getTime() <= Date.now()) return review('LATE_SYNCHRONIZATION');
  const membership = await client.query(`SELECT 1 FROM konektag.merchant_memberships mm JOIN konektag.merchant_profiles mp ON mp.id=mm.merchant_profile_id
    WHERE mm.merchant_profile_id=$1 AND mm.user_id=$2 AND mm.status='active' AND mm.role IN ('owner','manager')
      AND mp.user_id<>$3 AND mp.deleted_at IS NULL FOR SHARE OF mm,mp`, [order.merchantProfileId, verified.merchant.ownerUserId, order.ownerUserId]);
  if (!membership.rowCount) return review('MERCHANT_ACCESS_DENIED');
  let quantityValuationProofHash: string;
  if (verified.merchantOrder) {
    const merchantOrder = verified.merchantOrder;
    quantityValuationProofHash = merchantOrder.orderValuationProofHash;
    const orderValuationProofHash = createHash('sha256').update(JSON.stringify(merchantOrder.lines.map(line => line.valuation))).digest('hex');
    if (orderValuationProofHash !== merchantOrder.orderValuationProofHash || verified.qr.orderValuationProofHash !== orderValuationProofHash)
      return review('VALUATION_PROOF_MISMATCH');
    const { rows: pricingRows } = await client.query(`SELECT r.id, r.unit_price, r.currency, r.market_country,
        r.seller_legal_entity_code, r.pricing_version
      FROM konektag.product_pricing_rules r JOIN konektag.merchant_products p ON p.id=r.merchant_product_id
      WHERE r.id=ANY($1::uuid[]) AND r.merchant_profile_id=$2 AND r.status='APPROVED' AND r.deleted_at IS NULL
        AND p.deleted_at IS NULL AND r.valid_from <= to_timestamp($3) AND (r.valid_until IS NULL OR r.valid_until >= to_timestamp($3))`,
      [merchantOrder.lines.map(line => line.pricingRuleId), merchantOrder.merchantProfileId, merchantOrder.createdAt]);
    if (pricingRows.length !== merchantOrder.lines.length) return review('CATALOGUE_VERSION_REJECTED');
    for (const line of merchantOrder.lines) {
      const pricing = pricingRows.find(row => row.id === line.pricingRuleId);
      if (!pricing || Number(pricing.unit_price) !== line.unitPriceMinor || pricing.currency !== line.sourceCurrency ||
        pricing.market_country !== line.marketCountry || pricing.seller_legal_entity_code !== line.legalEntity ||
        Number(pricing.pricing_version) !== line.snapshotVersion) return review('CATALOGUE_VERSION_REJECTED');
      const valuation = await valuePointsK({ sourceCurrency: line.sourceCurrency, sourceAmountMinor: line.sourceAmountMinor,
        valuedAt: new Date(merchantOrder.createdAt * 1000), context: 'offline-merchant-order' }, client);
      if (JSON.stringify({ ...valuation, proofHash: undefined }) !== JSON.stringify({ ...line.valuation, proofHash: undefined }) ||
        valuation.proofHash !== line.valuation.proofHash) return review('VALUATION_PROOF_MISMATCH');
    }
  } else {
    // A plain offline QR carries a merchant-signed quantity: it must match the
    // official valuation of the signed amount at issuance.
    try { quantityValuationProofHash = (await verifyFixedQrQuantity(client, verified.qr)).proofHash; }
    catch (error) {
      if (error instanceof PointsQuantityError || error instanceof PointsKValuationError) return review('VALUATION_PROOF_MISMATCH');
      throw error;
    }
  }
  const { rows: [usage] } = await client.query(`SELECT count(*)::int AS count,
      COALESCE(sum(o.reference_amount_minor),0)::text AS total
    FROM konektag.core_payment_decisions d
    JOIN konektag.core_transaction_offline o ON o.transaction_id=d.transaction_id
    WHERE d.authorization_id=$1 AND d.state='SETTLED' AND o.reference_status='VERIFIED'`, [envelope.authorizationId]);
  const { rows: [authorizationRate] } = await client.query(
    `SELECT reference_rate::text AS rate, reference_rate_inverse AS inverse
     FROM konektag.core_offline_authorizations WHERE id=$1 FOR UPDATE`, [envelope.authorizationId]);
  if (!authorizationRate) return review('AUTHORIZATION_NOT_FOUND');
  const orderReferenceMinor = await serverEurMinor(client, order.amountMinor, order.currency,
    { rate: authorizationRate.rate, inverse: authorizationRate.inverse });
  if (orderReferenceMinor < 1) return review('REFERENCE_AMOUNT_INVALID');
  if (orderReferenceMinor > envelope.maximumSingleMinor ||
      usage.count >= envelope.maximumCount ||
      BigInt(usage.total) + BigInt(orderReferenceMinor) > BigInt(envelope.maximumTotalMinor))
    return review('ENVELOPE_EXHAUSTED');
  if (verified.qr.singleUse) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['offline-qr:' + verified.qr.requestId]);
    const { rows: [claim] } = await client.query(`SELECT order_hash FROM konektag.core_payment_qr_claims WHERE request_id=$1`, [verified.qr.requestId]);
    const online = await client.query(`SELECT id,status FROM konektag.checkout_intents WHERE public_id=$1 AND source_type='qr' FOR UPDATE`, [verified.qr.requestId]);
    if ((claim && claim.order_hash !== orderHash) || online.rows.some(row => row.status !== 'ISSUED')) return review('QR_ALREADY_USED');
    // Lock the online intent if it exists; absent intents remain protected by the offline claim.
    await client.query(`SELECT id FROM konektag.checkout_intents WHERE public_id=$1 AND source_type='qr' FOR UPDATE`, [verified.qr.requestId]);
  }
  const context = await resolveMerchantOperationCurrency(client, order.merchantProfileId, order.currency);
  const { rows: [tx] } = await client.query(`INSERT INTO konektag.core_transactions
    (merchant_profile_id,customer_user_id,kind,state,currency,total_minor,request_key,request_hash)
    VALUES($1,$2,'REQUEST','CREATED',$3,$4,$5,$6) RETURNING id`,
    [order.merchantProfileId, order.ownerUserId, order.currency, order.amountMinor, 'OFFLINE:' + order.operationId, orderHash]);
  await attachOfflineEvidence({ transactionId: tx.id, ownerUserId: order.ownerUserId, deviceId: order.deviceId,
    authorizationId: envelope.authorizationId, clientTransactionId: order.operationId, localCounter: order.localCounter,
    envelope: { token: proof.envelope }, proofs: proof, syncState: 'SYNC_PENDING' }, client);
  const result = await consumptionService.consumeAtMerchant({ idempotencyKey: 'OFFLINE:' + order.operationId,
    userId: order.ownerUserId, merchantProfileId: order.merchantProfileId, amount: order.amountMinor, quantityK: order.quantityK, currency: order.currency,
    merchantSaleRef: 'OFFLINE-' + order.operationId, rail: 'qr', paymentCountry: context.country, quantityValuationProofHash }, client);
  if (!result.success || !result.financialTransactionId || !result.merchantSaleId) throw new Error('OFFLINE_LEDGER_FAILED');
  await client.query(`UPDATE konektag.core_transactions SET state='CLOSED',state_version=state_version+1 WHERE id=$1`, [tx.id]);
  await client.query(`UPDATE konektag.core_transaction_offline SET sync_state='SETTLED' WHERE transaction_id=$1`, [tx.id]);
  if (verified.qr.singleUse) {
    await client.query(`INSERT INTO konektag.core_payment_qr_claims(request_id,order_hash) VALUES($1,$2) ON CONFLICT DO NOTHING`, [verified.qr.requestId, orderHash]);
    await client.query(`UPDATE konektag.checkout_intents SET status='CONSUMED',consumed_at=now(),financial_transaction_id=$2,core_transaction_id=$3
      WHERE public_id=$1 AND source_type='qr'`, [verified.qr.requestId, result.financialTransactionId, tx.id]);
  }
  return decide(client, verified, proof, orderHash, 'SETTLED', 'SETTLED', tx.id, result.financialTransactionId);
}

export async function synchronizePaymentBatch(userId: string, input: unknown) {
  const batch = BatchSchema.parse(input), trust = await roots();
  // Cryptographic rejection has no financial or durable decision side effect.
  const operations = await Promise.all(batch.operations.map(async proof => {
    const customer = CertificateSchema.parse(await verifyAuthority(proof.customerCertificate, trust, 'KTG-CERT2'));
    const merchant = CertificateSchema.parse(await verifyAuthority(proof.merchantCertificate, trust, 'KTG-CERT2'));
    const key = await crypto.subtle.importKey('jwk', customer.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const order = OrderSchema.parse(await verifyJws(proof.order, key, customer.keyId, 'KTG-OFFORDER1'));
    if (!((customer.ownerUserId === userId && customer.deviceId === batch.deviceId) ||
      (merchant.ownerUserId === userId && merchant.deviceId === batch.deviceId))) throw new Error('SUBMITTER_DENIED');
    try { return { customer, merchant, verified: await verifyProof(proof, trust, Math.floor(Date.now()/1000), true), rejected: null }; }
    catch {
      const rejected = await signAuthority(ReceiptSchema.parse({ version: 1, operationId: order.operationId,
        orderHash: await sha256(proof.order), state: 'REJECTED', reason: 'INVALID_PROOF',
        decidedAt: Math.floor(Date.now()/1000), decisionOrder: 0, transactionId: null, financialTransactionId: null }), 'KTG-OFFRESULT1');
      return { customer, merchant, verified: null, rejected };
    }
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const devices = [...new Set([batch.deviceId, ...operations.flatMap(v => [v.customer.deviceId, v.merchant.deviceId])])].sort();
    for (const device of devices) await client.query(`SELECT id FROM konektag.core_offline_devices WHERE id=$1 FOR UPDATE`, [device]);
    const submitter = await client.query(`SELECT id FROM konektag.core_offline_devices WHERE id=$1 AND owner_user_id=$2`, [batch.deviceId, userId]);
    if (!submitter.rowCount) throw new Error('SUBMITTER_DENIED');
    const requestHash = await sha256(batch);
    const { rows: [prior] } = await client.query(`SELECT request_hash,response FROM konektag.core_payment_batches WHERE device_id=$1 AND batch_id=$2`, [batch.deviceId, batch.batchId]);
    if (prior) {
      if (prior.request_hash !== requestHash) throw new Error('BATCH_CONFLICT');
      await client.query('COMMIT'); return prior.response;
    }
    const receipts: string[] = [];
    for (const operation of operations) receipts.push(operation.verified ? await apply(client, userId, batch.deviceId, operation.verified, trust) : operation.rejected!);
    const response = { version: 1, batchId: batch.batchId, receipts };
    await client.query(`INSERT INTO konektag.core_payment_batches(device_id,batch_id,request_hash,response) VALUES($1,$2,$3,$4)`, [batch.deviceId, batch.batchId, requestHash, response]);
    await client.query('COMMIT');
    return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
