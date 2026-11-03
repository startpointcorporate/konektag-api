import { z } from 'zod';
import { sha256, verifyJws } from '../core02/crypto.ts';
import { verifyAuthority, verifyCertificate, verifyQr, verifyRevocations } from '../core02/qr.ts';
import { MerchantOfflineOrderSchema, type MerchantOfflineOrder } from './merchant-order.ts';

const id = z.string().uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const token = z.string().min(1).max(4096);
export const EnvelopeSchema = z.object({
  version: z.literal(1), authorizationId: id, deviceId: id, ownerUserId: id,
  currency: z.string().regex(/^[A-Z]{3}$/), maximumCount: integer,
  maximumTotalMinor: integer, maximumSingleMinor: integer,
  issuedAt: integer, expiresAt: integer, decisionVersion: integer,
}).strict();
export const OrderSchema = z.object({
  version: z.literal(1), operationId: id, ownerUserId: id, deviceId: id, keyId: id,
  keyVersion: integer, localCounter: integer, previousHash: hash.nullable(),
  envelopeHash: hash, qrHash: hash, quantityK: integer.refine(n => n > 0), amountMinor: integer,
  currency: z.string().regex(/^[A-Z]{3}$/), merchantProfileId: id, issuedAt: integer,
}).strict();
export const AcceptanceSchema = z.object({
  version: z.literal(1), operationId: id, orderHash: hash, deviceId: id, keyId: id,
  keyVersion: integer, merchantProfileId: id, acceptedAt: integer,
  localCounter: integer, previousHash: hash.nullable(),
}).strict();
export const ProofSchema = z.object({
  envelope: token, qr: token, order: token, customerCertificate: token,
  merchantCertificate: token, revocations: z.string().max(2000000),
  acceptance: token.nullable(),
}).strict();
export const BatchSchema = z.object({ version: z.literal(1), batchId: id, deviceId: id,
  operations: z.array(ProofSchema).min(1).max(10),
}).strict();
export const ReceiptSchema = z.object({ version: z.literal(1), operationId: id,
  orderHash: hash, state: z.enum(['SETTLED', 'REJECTED', 'REQUIRES_REVIEW']),
  reason: z.string().max(100), decidedAt: integer, decisionOrder: integer,
  transactionId: id.nullable(), financialTransactionId: id.nullable(),
}).strict();
export type Proof = z.infer<typeof ProofSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type Roots = Record<string, CryptoKey>;

export async function verifyEnvelope(token: string, roots: Roots, at: number) {
  const envelope = EnvelopeSchema.parse(await verifyAuthority(token, roots, 'KTG-OFFENV1'));
  if (at < envelope.issuedAt || at >= envelope.expiresAt || envelope.expiresAt - envelope.issuedAt > 86400 ||
    envelope.maximumCount < 1 || envelope.maximumCount > 10 || envelope.maximumSingleMinor < 1 ||
    envelope.maximumSingleMinor > envelope.maximumTotalMinor) throw new Error('ENVELOPE_INVALID');
  return envelope;
}

// Certificate signatures are checked before using any device-provided identity or timestamp.
export async function verifyProof(input: Proof, roots: Roots, now: number, historical = false) {
  const proof = ProofSchema.parse(input);
  const { CertificateSchema } = await import('../core02/contracts.ts');
  const customer = CertificateSchema.parse(await verifyAuthority(proof.customerCertificate, roots, 'KTG-CERT2'));
  const customerKey = await crypto.subtle.importKey('jwk', customer.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const order = OrderSchema.parse(await verifyJws(proof.order, customerKey, customer.keyId, 'KTG-OFFORDER1'));
  const at = historical ? order.issuedAt : now;
  await verifyCertificate(proof.customerCertificate, roots, at);
  const envelope = await verifyEnvelope(proof.envelope, roots, at);
  const merchant = await verifyCertificate(proof.merchantCertificate, roots, at);
  const qr = await verifyQr(proof.qr, { roots, certificates: [proof.merchantCertificate], revocations: proof.revocations, now: at });
  // Offline payment needs a signed amount and quantity; the payer cannot choose one without the server.
  if (qr.variableAmount) throw new Error('VARIABLE_QR_OFFLINE_UNSUPPORTED');
  const revocations = await verifyRevocations(proof.revocations, roots, at);
  if (revocations.entries.some(v => v.keyId === customer.keyId || v.deviceId === customer.deviceId)) throw new Error('DEVICE_REVOKED');
  let merchantOrder: MerchantOfflineOrder | null = null;
  if (qr.orderHash || qr.orderProof) {
    if (!qr.orderHash || !qr.orderProof) throw new Error('MERCHANT_ORDER_EVIDENCE_INCOMPLETE');
    const merchantKey = await crypto.subtle.importKey('jwk', merchant.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    merchantOrder = MerchantOfflineOrderSchema.parse(await verifyJws(qr.orderProof, merchantKey, merchant.keyId, 'KTG-OFFMERCHANTORDER1'));
    if (merchantOrder.merchantProfileId !== qr.beneficiaryId || merchantOrder.orderId !== qr.reference ||
      merchantOrder.quantityK !== qr.quantityK || merchantOrder.sourceAmountMinor !== qr.amount ||
      merchantOrder.sourceCurrency !== qr.currency || merchantOrder.merchantDeviceId !== merchant.deviceId ||
      merchantOrder.merchantKeyId !== merchant.keyId || merchantOrder.merchantKeyVersion !== merchant.keyVersion ||
      merchantOrder.expiresAt > qr.expiresAt || merchantOrder.createdAt !== qr.issuedAt ||
      await sha256(qr.orderProof) !== qr.orderHash || qr.orderValuationProofHash !== merchantOrder.orderValuationProofHash) throw new Error('MERCHANT_ORDER_MISMATCH');
  }
  if (order.issuedAt > now || order.issuedAt < envelope.issuedAt || order.issuedAt >= envelope.expiresAt ||
    order.issuedAt < customer.activatedAt || order.issuedAt >= customer.expiresAt ||
    customer.deviceId !== order.deviceId || customer.ownerUserId !== order.ownerUserId ||
    customer.keyId !== order.keyId || customer.keyVersion !== order.keyVersion ||
    envelope.deviceId !== order.deviceId || envelope.ownerUserId !== order.ownerUserId ||
    envelope.currency !== order.currency || order.quantityK !== qr.quantityK || order.amountMinor !== qr.amount ||
    qr.beneficiaryType !== 'MERCHANT' || qr.beneficiaryId !== order.merchantProfileId ||
    merchant.ownerUserId === customer.ownerUserId ||
    order.envelopeHash !== await sha256(proof.envelope) || order.qrHash !== await sha256(proof.qr)) throw new Error('ORDER_MISMATCH');
  let acceptance: z.infer<typeof AcceptanceSchema> | null = null;
  if (proof.acceptance) {
    const key = await crypto.subtle.importKey('jwk', merchant.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    acceptance = AcceptanceSchema.parse(await verifyJws(proof.acceptance, key, merchant.keyId, 'KTG-OFFACK1'));
    await verifyCertificate(proof.merchantCertificate, roots, acceptance.acceptedAt);
    if (acceptance.orderHash !== await sha256(proof.order) || acceptance.operationId !== order.operationId ||
      acceptance.deviceId !== merchant.deviceId || acceptance.keyId !== merchant.keyId ||
      acceptance.keyVersion !== merchant.keyVersion || acceptance.merchantProfileId !== order.merchantProfileId ||
      acceptance.acceptedAt < order.issuedAt || acceptance.acceptedAt > now ||
      acceptance.acceptedAt >= envelope.expiresAt || acceptance.acceptedAt >= qr.expiresAt ||
      acceptance.acceptedAt >= revocations.expiresAt) throw new Error('ACCEPTANCE_MISMATCH');
  }
  return { proof, order, envelope, merchant, customer, qr, acceptance, merchantOrder };
}

// A settled operation still consumes its envelope. Replaying cannot replenish it.
export function localAvailable(envelope: Envelope, orders: Order[]) {
  const own = orders.filter(o => o.deviceId === envelope.deviceId && o.envelopeHash);
  const spent = own.reduce((sum, o) => sum + BigInt(o.amountMinor), 0n);
  return { amountMinor: Number(BigInt(envelope.maximumTotalMinor) > spent ? BigInt(envelope.maximumTotalMinor) - spent : 0n),
    count: Math.max(0, envelope.maximumCount - own.length) };
}
