import { z } from 'zod';
import { sha256, signJws } from '../core02/crypto.ts';
import { PointsKValuationSchema, type PointsKValuation } from '../../../domain/points-k-valuation.ts';

const uuid = z.string().uuid();
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const MerchantOfflineOrderLineSchema = z.object({
  offerId: uuid, pricingRuleId: uuid, name: z.string().min(1).max(400), quantity: integer,
  unitPriceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/), sourceAmountMinor: integer,
  marketCountry: z.string().regex(/^[A-Z]{2}$/), legalEntity: z.string().min(1).max(120),
  snapshotVersion: integer, valuation: PointsKValuationSchema,
}).strict();

export const MerchantOfflineOrderSchema = z.object({
  version: z.literal(1), orderId: uuid, merchantProfileId: uuid, establishmentId: uuid,
  merchantOwnerUserId: uuid, merchantDeviceId: uuid, merchantKeyId: uuid, merchantKeyVersion: integer,
  lines: z.array(MerchantOfflineOrderLineSchema).min(1).max(100), snapshotVersion: integer,
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/), sourceAmountMinor: integer, eurAmountMinor: integer,
  quantityK: integer, matrixVersion: integer, orderValuationProofHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: integer, expiresAt: integer, nonce: uuid, idempotencyKey: uuid,
}).strict().superRefine((order, ctx) => {
  if (order.expiresAt <= order.createdAt || order.expiresAt - order.createdAt > 24 * 60 * 60)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ORDER_EXPIRATION_INVALID', path: ['expiresAt'] });
  const source = order.lines.reduce((sum, line) => sum + line.sourceAmountMinor, 0);
  const eur = order.lines.reduce((sum, line) => sum + line.valuation.eurAmountMinor, 0);
  const points = order.lines.reduce((sum, line) => sum + line.valuation.quantityK, 0);
  if (source !== order.sourceAmountMinor || eur !== order.eurAmountMinor || points !== order.quantityK)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ORDER_VALUATION_TOTAL_MISMATCH' });
  if (order.lines.some(line => line.valuation.sourceCurrency !== line.sourceCurrency || line.valuation.sourceAmountMinor !== line.sourceAmountMinor))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ORDER_VALUATION_LINE_MISMATCH' });
  if (order.lines.some(line => line.snapshotVersion !== order.snapshotVersion || line.valuation.matrixVersion !== order.matrixVersion || line.sourceCurrency !== order.sourceCurrency))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ORDER_VERSION_MATRIX_MISMATCH' });
});

export type MerchantOfflineOrder = z.infer<typeof MerchantOfflineOrderSchema>;
export type MerchantOfflineCartLine = {
  offerId: string; pricingRuleId: string; name: string; quantity: number; amountMinor: number;
  currency: string; marketCountry: string; legalEntity: string; minQuantity: number | null;
  maxQuantity: number | null; pricingVersion?: number;
  offlineValuations?: Array<PointsKValuation & { quantity: number; unitPriceMinor: number }>;
};

export function validateMerchantOfflineCart(lines: MerchantOfflineCartLine[]) {
  if (!lines.length) throw new Error('OFFLINE_CART_EMPTY');
  const currency = lines[0].currency, snapshotVersion = lines[0].pricingVersion;
  for (const line of lines) {
    const min = line.minQuantity ?? 1;
    if (!Number.isSafeInteger(line.quantity) || line.quantity < min ||
      (line.maxQuantity !== null && line.maxQuantity !== undefined && line.quantity > line.maxQuantity))
      throw new Error('OFFLINE_QUANTITY_OUT_OF_RANGE');
    if (line.currency !== currency) throw new Error('OFFLINE_CART_CURRENCY_MISMATCH');
    if (snapshotVersion !== undefined && line.pricingVersion !== snapshotVersion)
      throw new Error('OFFLINE_SNAPSHOT_VERSION_CONFLICT');
    if (!line.offlineValuations?.some(value => value.quantity === line.quantity))
      throw new Error('POINTS_K_VALUATION_UNAVAILABLE');
  }
}

async function sha256Hex(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createMerchantOfflineOrder(input: {
  merchantProfileId: string; establishmentId?: string; merchantCertificate: any;
  cart: MerchantOfflineCartLine[]; now?: number; lifetimeSeconds?: number; sign: CryptoKey;
}) {
  validateMerchantOfflineCart(input.cart);
  const now = input.now ?? Math.floor(Date.now() / 1000), lifetime = input.lifetimeSeconds ?? 900;
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 86400) throw new Error('ORDER_EXPIRATION_INVALID');
  const lines = input.cart.map(line => {
    const selected = line.offlineValuations!.find(value => value.quantity === line.quantity)!;
    const { quantity: _quantity, unitPriceMinor: _unitPriceMinor, ...valuation } = selected;
    return { offerId: line.offerId, pricingRuleId: line.pricingRuleId, name: line.name, quantity: line.quantity,
      unitPriceMinor: line.amountMinor, sourceCurrency: line.currency, sourceAmountMinor: line.amountMinor * line.quantity,
      marketCountry: line.marketCountry, legalEntity: line.legalEntity, snapshotVersion: line.pricingVersion ?? 1, valuation };
  });
  const first = lines[0];
  const order = MerchantOfflineOrderSchema.parse({ version: 1, orderId: crypto.randomUUID(), merchantProfileId: input.merchantProfileId,
    establishmentId: input.establishmentId ?? input.merchantProfileId, merchantOwnerUserId: input.merchantCertificate.ownerUserId,
    merchantDeviceId: input.merchantCertificate.deviceId, merchantKeyId: input.merchantCertificate.keyId,
    merchantKeyVersion: input.merchantCertificate.keyVersion, lines, snapshotVersion: first.snapshotVersion,
    sourceCurrency: first.sourceCurrency, sourceAmountMinor: lines.reduce((sum, line) => sum + line.sourceAmountMinor, 0),
    eurAmountMinor: lines.reduce((sum, line) => sum + line.valuation.eurAmountMinor, 0),
    quantityK: lines.reduce((sum, line) => sum + line.valuation.quantityK, 0), matrixVersion: first.valuation.matrixVersion,
    orderValuationProofHash: await sha256Hex(lines.map(line => line.valuation)), createdAt: now, expiresAt: now + lifetime,
    nonce: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
  const proof = await signJws(order, input.sign, input.merchantCertificate.keyId, 'KTG-OFFMERCHANTORDER1');
  return { order, proof, orderHash: await sha256(proof) };
}
