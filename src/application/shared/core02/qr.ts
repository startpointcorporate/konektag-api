import { base64urlDecode, verifyJws, signJws } from './crypto.ts';
import { z } from 'zod';
import { QrPaymentSchema, CertificateSchema, RevocationsSchema, type PublicKey, assertTimeWindow, assertCurrentQrContract, } from './contracts.ts';
/**
 * Verify an authority signed token, returning its payload.
 * @param token JWS token
 * @param roots Map of trusted CryptoKey by kid
 * @param typ Expected typ in header
 */
export async function verifyAuthority(token: string, roots: Record<string, CryptoKey>, typ: string): Promise<any> {
    if (typeof token !== 'string' || token.length > (typ === 'KTG-REV2' ? 2000000 : 4096))
        throw new Error('Token exceeds maximum length');
    const parts = token.split('.');
    if (parts.length !== 3)
        throw new Error('Malformed JWS token');
    const headerB64 = parts[0];
    const headerBytes = base64urlDecode(headerB64);
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes)) as any;
    const kid = header.kid;
    if (!kid)
        throw new Error('Header missing kid');
    if (!Object.prototype.hasOwnProperty.call(roots, kid))
        throw new Error('UNKNOWN_AUTHORITY');
    const pub = roots[kid];
    if (!pub)
        throw new Error('Unknown key');
    // verify signature
    return await verifyJws(token, pub, kid, typ);
}
/**
 * Verify a certificate token.
 */
export async function verifyCertificate(token: string, roots: Record<string, CryptoKey>, now: number): Promise<z.infer<typeof CertificateSchema>> {
    const payload = await verifyAuthority(token, roots, 'KTG-CERT2');
    const cert = CertificateSchema.parse(payload);
    assertTimeWindow(cert.activatedAt, cert.expiresAt, now);
    if (now >= cert.keyExpiresAt)
        throw new Error('Certificate key expired');
    return cert;
}
/**
 * Verify a revocations token.
 */
export async function verifyRevocations(token: string, roots: Record<string, CryptoKey>, now: number, minRevision = 0, minIssuedAt = 0): Promise<z.infer<typeof RevocationsSchema>> {
    const payload = await verifyAuthority(token, roots, 'KTG-REV2');
    const rev = RevocationsSchema.parse(payload);
    assertTimeWindow(rev.issuedAt, rev.expiresAt, now);
    if (rev.revision < minRevision)
        throw new Error('Rollback revision');
    if (rev.issuedAt < minIssuedAt)
        throw new Error('Rollback issuedAt');
    return rev;
}
/**
 * Verify a QR token.
 */
export async function verifyQr(token: string, options: {
    roots: Record<string, CryptoKey>;
    certificates: string[];
    revocations: string;
    now: number;
    minimumTime?: number;
    minRevision?: number;
    minIssuedAt?: number;
}): Promise<z.infer<typeof QrPaymentSchema>> {
    const { roots, certificates, revocations, now, minimumTime, minRevision = 0, minIssuedAt = 0 } = options;
    // initial sanity
    if (token.length > 4096)
        throw new Error('Token exceeds maximum length');
    const parts = token.split('.');
    if (parts.length !== 3)
        throw new Error('Malformed JWS token');
    const payloadB64 = parts[1];
    let rawPayload: any;
    try {
        rawPayload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
    }
    catch (e) {
        throw new Error('Invalid payload JSON');
    }
    assertCurrentQrContract(rawPayload);
    rawPayload = QrPaymentSchema.parse(rawPayload);
    const candidateKeyId = rawPayload.keyId;
    if (typeof candidateKeyId !== 'string')
        throw new Error('Missing keyId');
    // Verify fresh revocations and reject revoked key
    const revokedSet = new Set((await verifyRevocations(revocations, roots, now, minRevision, minIssuedAt)).entries.map((e) => e.keyId));
    if (revokedSet.has(candidateKeyId))
        throw new Error('Key revoked');
    // Find matching certificate
    let chosenCert: z.infer<typeof CertificateSchema> | null = null;
    for (const certToken of certificates) {
        try {
            const cert = await verifyCertificate(certToken, roots, now);
            if (cert.usage !== 'QR_PAYMENT' && !(rawPayload.beneficiaryType === 'USER' && cert.usage === 'DEVICE'))
                continue;
            if (cert.keyId !== candidateKeyId)
                continue;
            if (cert.keyVersion !== rawPayload.keyVersion)
                continue;
            if (cert.deviceId !== rawPayload.issuerDeviceId ||
                (rawPayload.beneficiaryType === 'MERCHANT'
                    ? cert.merchantProfileId !== rawPayload.beneficiaryId || cert.merchantName !== rawPayload.displayName
                    : cert.merchantProfileId !== null || cert.ownerUserId !== rawPayload.beneficiaryId || cert.merchantName !== null || rawPayload.displayName.length < 1)) {
                continue;
            }
            // candidate within cert window
            if (rawPayload.issuedAt < cert.activatedAt || rawPayload.expiresAt > cert.expiresAt)
                continue;
            chosenCert = cert;
            break;
        }
        catch {
            continue;
        }
    }
    if (!chosenCert)
        throw new Error('UNKNOWN_KEY');
    // Import public key
    const pubJwk: PublicKey = chosenCert.publicKey;
    const importKey = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const verifiedPayload = await verifyJws(token, importKey, chosenCert.keyId, 'KTG-QR2');
    // Validate payload schema and time window
    const qr = QrPaymentSchema.parse(verifiedPayload);
    assertTimeWindow(qr.issuedAt, qr.expiresAt, now);
    if (minimumTime && now < minimumTime)
        throw new Error('Token too early');
    return qr;
}
/**
 * Sign a QR payment token.
 */
export async function signQr(payload: z.infer<typeof QrPaymentSchema>, key: CryptoKey, certificate: z.infer<typeof CertificateSchema>, now: number): Promise<string> {
    payload = QrPaymentSchema.parse(payload);
    certificate = CertificateSchema.parse(certificate);
    assertTimeWindow(certificate.activatedAt, certificate.expiresAt, now);
    assertTimeWindow(payload.issuedAt, payload.expiresAt, now);
    if (payload.keyId !== certificate.keyId)
        throw new Error('KEY_MISMATCH');
    if (payload.keyVersion !== certificate.keyVersion)
        throw new Error('KEY_VERSION_MISMATCH');
    // Validate payload against certificate properties
    if (payload.issuerDeviceId !== certificate.deviceId ||
        (payload.beneficiaryType === 'MERCHANT'
            ? certificate.merchantProfileId !== payload.beneficiaryId || certificate.merchantName !== payload.displayName
            : certificate.merchantProfileId !== null || certificate.ownerUserId !== payload.beneficiaryId || certificate.merchantName !== null)) {
        throw new Error('Payload does not match certificate identity');
    }
    if (certificate.usage !== 'QR_PAYMENT' && !(payload.beneficiaryType === 'USER' && certificate.usage === 'DEVICE'))
        throw new Error('Certificate not for QR_PAYMENT');
    // ensure time within certificate window
    if (payload.issuedAt < certificate.activatedAt || payload.expiresAt > certificate.expiresAt) {
        throw new Error('Payload outside certificate window');
    }
    // Sign
    return await signJws(payload, key, certificate.keyId, 'KTG-QR2');
}
/**
 * Classify a QR token or data.
 */
export function classifyQr(text: string, online: boolean): {
    version: 1;
    payload: any;
} | {
    version: 2;
    token: string;
} {
    if (typeof text !== 'string' || text.length > 4096)
        throw new Error('QR_FORMAT_INVALID');
    const parts = text.split('.');
    if (parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)))
        return { version: 2, token: text };
    throw new Error(online ? 'QR_FORMAT_UNSUPPORTED' : 'QR_FORMAT_INVALID');
}
/**
 * Select customer amount for variable QR payments.
 */
export function selectCustomerAmount(qr: z.infer<typeof QrPaymentSchema>, minor: number) {
    if (!qr.variableAmount)
        throw new Error('Not variable amount');
    if (!Number.isSafeInteger(minor) || minor <= 0)
        throw new Error('Invalid amount');
    return { qr: { ...qr }, customerAmountMinor: minor };
}
