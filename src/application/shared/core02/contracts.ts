import { z } from 'zod';
// Helper to assert that a given time window is valid (now is not in the future or past)
export function assertTimeWindow(issuedAt: number, expiresAt: number, now: number): void {
    if (![issuedAt, expiresAt, now].every(n => Number.isSafeInteger(n) && n > 0) || expiresAt <= issuedAt) {
        throw new Error('issuedAt and expiresAt must be numbers');
    }
    if (now < issuedAt) {
        throw new Error('Time is in the future relative to issuedAt');
    }
    if (now >= expiresAt) {
        throw new Error('Time is past the expiration window');
    }
}
// Base64url 43 character string regex
const base64url43 = /^(?:[A-Za-z0-9_-]{43})$/;
// Public Key Schema (JWK)
export const PublicKeySchema = z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().regex(base64url43, { message: 'x must be a base64url 43 char string' }),
    y: z.string().regex(base64url43, { message: 'y must be a base64url 43 char string' }),
    ext: z.literal(true).optional(),
    key_ops: z.tuple([z.literal('verify')]).optional(),
}).strict();
export type PublicKey = z.infer<typeof PublicKeySchema>;
// PostgreSQL VARCHAR counts Unicode code points, not UTF-16 code units.
const MerchantNameSchema = z.string().min(1).max(400).refine(
    value => [...value].length <= 200 && !/[\uD800-\uDFFF\u0000]/u.test(value),
    { message: 'Merchant name must contain at most 200 Unicode characters' },
);
// QR Payment Schema
export const QrPaymentSchema = z.object({
    v: z.literal(2),
    type: z.literal('qr_payment'),
    requestId: z.string().uuid(),
    beneficiaryType: z.enum(['USER', 'MERCHANT']),
    beneficiaryId: z.string().uuid(),
    issuerDeviceId: z.string().uuid(),
    displayName: MerchantNameSchema,
    // Fixed QR only: both are signed. A variable QR carries neither; the server
    // values the payer-chosen amount with the official Points K valuation.
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    quantityK: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    variableAmount: z.boolean(),
    currency: z.string().regex(/^[A-Z]{3}$/, { message: 'currency must be three uppercase letters' }),
    reference: z.string().max(120),
    issuedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    singleUse: z.boolean(),
    keyId: z.string().uuid(),
    keyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    orderHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    orderProof: z.string().min(1).max(4096).optional(),
    // Proof of the approved reference used to convert the commercial amount into Points K.
    valuationProofHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    // Proof of the valuation of the signed offline order lines; only with the order evidence.
    orderValuationProofHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((data) => data.expiresAt > data.issuedAt && data.expiresAt - data.issuedAt <= 24 * 60 * 60, {
    message: 'expiresAt must be after issuedAt and within 24 hours',
})
    .refine((data) => data.orderValuationProofHash === undefined || (data.orderHash !== undefined && data.orderProof !== undefined), {
    message: 'orderValuationProofHash requires the merchant order evidence',
})
    .refine((data) => {
    if (data.variableAmount) {
        return data.amount === undefined && data.quantityK === undefined && data.singleUse === false;
    }
    return data.amount !== undefined && data.quantityK !== undefined && data.singleUse === true;
}, {
    message: 'Amount, quantityK and singleUse must match variableAmount flag',
}).refine((data) => Boolean(data.orderHash) === Boolean(data.orderProof), {
    message: 'Merchant order hash and proof must be provided together',
});
export type QrPayment = z.infer<typeof QrPaymentSchema>;
/** Variable QRs signed before the server-valued contract carried amount 0 and a placeholder quantityK. */
export function assertCurrentQrContract(payload: unknown): void {
    const raw = payload as { variableAmount?: unknown; amount?: unknown; quantityK?: unknown } | null;
    if (raw?.variableAmount === true && (raw.amount !== undefined || raw.quantityK !== undefined))
        throw new Error('QR_CONTRACT_OUTDATED');
}
// Certificate Schema
export const CertificateSchema = z.object({
    version: z.literal(2),
    deviceId: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    keyId: z.string().uuid(),
    keyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    publicKey: PublicKeySchema,
    merchantProfileId: z.string().uuid().nullable(),
    merchantName: MerchantNameSchema.nullable(),
    usage: z.enum(['DEVICE', 'QR_PAYMENT']),
    activatedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    keyExpiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: z.literal('ACTIVE'),
}).strict()
    .refine((data) => {
    const window = data.expiresAt - data.activatedAt;
    return (window > 0 && window <= 86400) && (data.expiresAt <= data.keyExpiresAt);
}, {
    message: 'Certificate active window must be <= 86400 seconds and expiresAt <= keyExpiresAt',
})
    .refine((data) => {
    if (data.usage === 'QR_PAYMENT') return true;
    if (data.usage === 'DEVICE') {
        return data.merchantProfileId === null && data.merchantName === null;
    }
    return true;
}, {
    message: 'Merchant fields required based on usage',
});
export type Certificate = z.infer<typeof CertificateSchema>;
// Revocations Schema
const RevocationEntrySchema = z.object({
    deviceId: z.string().uuid(),
    keyId: z.string().uuid(),
    revokedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const RevocationsSchema = z.object({
    version: z.literal(2),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    issuedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    entries: z.array(RevocationEntrySchema).max(10000),
}).strict().refine((data) => {
    const validity = data.expiresAt - data.issuedAt;
    return validity > 0 && validity <= 3600;
}, {
    message: 'Revocations validity must not exceed 3600 seconds',
});
export type Revocations = z.infer<typeof RevocationsSchema>;
export const DeviceProofSchema = z.object({ version: z.literal(2), type: z.literal('device_identity'), action: z.enum(['enroll', 'rotate', 'renew']), ownerUserId: z.string().uuid(), deviceId: z.string().uuid(), keyId: z.string().uuid(), publicKey: PublicKeySchema, merchantProfileId: z.string().uuid().nullable(), expectedVersion: z.number().int().nonnegative().max(2147483646), issuedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().refine(v => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 300);
export type DeviceProof = z.infer<typeof DeviceProofSchema>;
