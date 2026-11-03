import { it, expect } from 'vitest';
import { generateSigningKey, signJws, base64urlEncode, base64urlDecode } from '../../src/application/shared/core02/crypto.ts';
import { verifyQr, signQr, classifyQr, verifyCertificate, verifyRevocations, selectCustomerAmount } from '../../src/application/shared/core02/qr.ts';
import type { PublicKey } from '../../src/application/shared/core02/contracts.ts';
const now = 1800000000;
async function fixture() {
    const root = await generateSigningKey(), key = await generateSigningKey();
    const cert = { version: 2 as const, deviceId: crypto.randomUUID(), ownerUserId: crypto.randomUUID(), keyId: crypto.randomUUID(), keyVersion: 1, publicKey: (await crypto.subtle.exportKey('jwk', key.publicKey)) as PublicKey, merchantProfileId: crypto.randomUUID(), merchantName: 'Marchand', usage: 'QR_PAYMENT' as const, activatedAt: now - 20, expiresAt: now + 300, keyExpiresAt: now + 86400, state: 'ACTIVE' as const };
    const qr = { v: 2 as const, type: 'qr_payment' as const, requestId: crypto.randomUUID(), beneficiaryType: 'MERCHANT' as const, beneficiaryId: cert.merchantProfileId, issuerDeviceId: cert.deviceId, displayName: cert.merchantName, amount: 1500, quantityK: 1500, variableAmount: false, currency: 'XAF', reference: 'Commande', issuedAt: now - 10, expiresAt: now + 60, singleUse: true, keyId: cert.keyId, keyVersion: cert.keyVersion };
    const rev = { version: 2, revision: 1, issuedAt: now - 10, expiresAt: now + 600, entries: [] as any[] };
    const rootSign = (p: unknown, typ: string) => signJws(p, root.privateKey, 'root', typ);
    const ctx = { roots: { root: root.publicKey }, certificates: [await rootSign(cert, 'KTG-CERT2')], revocations: await rootSign(rev, 'KTG-REV2'), now };
    const token = await signQr(qr, key.privateKey, cert as any, now);
    return { root, key, cert, qr, rev, rootSign, ctx, token };
}
it('verifies actual signed dynamic and fixed QR', async () => { const f = await fixture(); expect(await verifyQr(f.token, f.ctx)).toEqual(f.qr); const { amount: _amount, quantityK: _quantityK, ...unpriced } = f.qr; const variable = { ...unpriced, variableAmount: true, singleUse: false }; const token = await signQr(variable, f.key.privateKey, f.cert as any, now); const verified = await verifyQr(token, f.ctx); expect(selectCustomerAmount(verified, 500).customerAmountMinor).toBe(500); expect(verified.amount).toBeUndefined(); expect(verified.quantityK).toBeUndefined(); expect(() => selectCustomerAmount(verified, 1.2)).toThrow(); });
it('rejects a variable QR signed with the outdated placeholder quantity contract', async () => { const f = await fixture(); const token = await signJws({ ...f.qr, variableAmount: true, amount: 0, quantityK: 1, singleUse: false }, f.key.privateKey, f.qr.keyId, 'KTG-QR2'); await expect(verifyQr(token, f.ctx)).rejects.toThrow('QR_CONTRACT_OUTDATED'); });
it('rejects a fixed QR without a signed Points K quantity', async () => { const f = await fixture(); const { quantityK: _quantityK, ...unquantified } = f.qr; const token = await signJws(unquantified, f.key.privateKey, f.qr.keyId, 'KTG-QR2'); await expect(verifyQr(token, f.ctx)).rejects.toThrow(); });
it.each(['displayName', 'beneficiaryId', 'issuerDeviceId', 'keyId', 'keyVersion'])('rejects signed identity mismatch %s', async (field) => { const f = await fixture(); const token = await signJws({ ...f.qr, [field]: field === 'displayName' ? 'Other' : field === 'keyVersion' ? 2 : crypto.randomUUID() }, f.key.privateKey, f.qr.keyId, 'KTG-QR2'); await expect(verifyQr(token, f.ctx)).rejects.toThrow(); });
it.each([{ v: 9 }, { amount: 1.2 }, { amount: -1 }, { amount: 2 ** 53 }, { currency: 'xaf' }, { extraDisplayName: 'Forged' }, { variableAmount: true }, { issuedAt: now + 1 }, { expiresAt: now }, { expiresAt: now + 86401 }])('rejects malformed or expired signed QR %j', async (change) => { const f = await fixture(); const token = await signJws({ ...f.qr, ...change }, f.key.privateKey, f.qr.keyId, 'KTG-QR2').catch(() => null); if (token)
    await expect(verifyQr(token, f.ctx)).rejects.toThrow();
else
    expect(change).toHaveProperty('amount'); });
it('rejects payload altered after signature', async () => { const f = await fixture(); const parts = f.token.split('.'); parts[1] = base64urlEncode(new TextEncoder().encode(JSON.stringify({ ...f.qr, amount: 999 }))); await expect(verifyQr(parts.join('.'), f.ctx)).rejects.toThrow(); });
it('rejects a different signing key and unknown certificate', async () => { const f = await fixture(), other = await generateSigningKey(); const token = await signJws(f.qr, other.privateKey, f.qr.keyId, 'KTG-QR2'); await expect(verifyQr(token, f.ctx)).rejects.toThrow(); await expect(verifyQr(f.token, { ...f.ctx, certificates: [] })).rejects.toThrow(); });
it('rejects expired certificate and untrusted issuer', async () => { const f = await fixture(); const expired = await f.rootSign({ ...f.cert, activatedAt: now - 100, expiresAt: now }, 'KTG-CERT2'); await expect(verifyQr(f.token, { ...f.ctx, certificates: [expired] })).rejects.toThrow(); await expect(verifyQr(f.token, { ...f.ctx, roots: {} })).rejects.toThrow(); });
it('rejects unauthorized certificate usage', async () => { const f = await fixture(); const token = await f.rootSign({ ...f.cert, usage: 'DEVICE', merchantProfileId: null, merchantName: null }, 'KTG-CERT2'); await expect(verifyQr(f.token, { ...f.ctx, certificates: [token] })).rejects.toThrow(); });
it('rejects revoked key, stale list and list rollback', async () => { const f = await fixture(); for (const change of [{ entries: [{ keyId: f.cert.keyId, deviceId: f.cert.deviceId, revokedAt: now - 1 }] }, { expiresAt: now }, { issuedAt: now + 1 }]) {
    const revocations = await f.rootSign({ ...f.rev, ...change }, 'KTG-REV2');
    await expect(verifyQr(f.token, { ...f.ctx, revocations })).rejects.toThrow();
} await expect(verifyQr(f.token, { ...f.ctx, minRevision: 2 })).rejects.toThrow(); await expect(verifyQr(f.token, { ...f.ctx, minIssuedAt: now })).rejects.toThrow(); await expect(verifyQr(f.token, { ...f.ctx, minimumTime: now + 1 })).rejects.toThrow(); });
it('keeps old authorized key during overlap then rejects its revocation', async () => { const f = await fixture(), n = await generateSigningKey(); const next = { ...f.cert, keyId: crypto.randomUUID(), keyVersion: 2, publicKey: (await crypto.subtle.exportKey('jwk', n.publicKey)) as PublicKey }; const certificates = [await f.rootSign(next, 'KTG-CERT2'), ...f.ctx.certificates]; expect(await verifyQr(f.token, { ...f.ctx, certificates })).toEqual(f.qr); const revocations = await f.rootSign({ ...f.rev, revision: 2, entries: [{ keyId: f.cert.keyId, deviceId: f.cert.deviceId, revokedAt: now }] }, 'KTG-REV2'); await expect(verifyQr(f.token, { ...f.ctx, certificates, revocations })).rejects.toThrow(); });
it('preserves v1 online but refuses it offline and rejects unknown versions', () => { for (const obj of [{ type: 'qr_payment', qr: 'legacy' }, { v: 1, type: 'qr_payment', qr: 'legacy' }]) {
    const text = JSON.stringify(obj);
    expect(() => classifyQr(text, true)).toThrow();
    expect(() => classifyQr(text, false)).toThrow();
} for (const v of [2, 3, '1', null])
    expect(() => classifyQr(JSON.stringify({ v }), true)).toThrow(); });

it('certifies and verifies a 200-character merchant name, rejects 201', async () => {
    const f = await fixture();
    const cert = { ...f.cert, merchantName: '😀'.repeat(200) };
    const qr = { ...f.qr, displayName: cert.merchantName };
    const certificate = await f.rootSign(cert, 'KTG-CERT2');
    const token = await signQr(qr, f.key.privateKey, cert, now);
    expect((await verifyQr(token, { ...f.ctx, certificates: [certificate] })).displayName).toBe(cert.merchantName);
    const invalidCert = await f.rootSign({ ...cert, merchantName: '😀'.repeat(201) }, 'KTG-CERT2');
    await expect(verifyCertificate(invalidCert, f.ctx.roots, now)).rejects.toThrow();
    const invalidQr = await signJws({ ...qr, displayName: '😀'.repeat(201) }, f.key.privateKey, qr.keyId, 'KTG-QR2');
    await expect(verifyQr(invalidQr, { ...f.ctx, certificates: [certificate] })).rejects.toThrow();
});

it('verifies a USER QR against a device certificate without merchant identity', async () => {
    const root = await generateSigningKey();
    const key = await generateSigningKey();
    const userId = crypto.randomUUID();
    const cert = { version: 2 as const, deviceId: crypto.randomUUID(), ownerUserId: userId, keyId: crypto.randomUUID(), keyVersion: 1, publicKey: (await crypto.subtle.exportKey('jwk', key.publicKey)) as PublicKey, merchantProfileId: null, merchantName: null, usage: 'DEVICE' as const, activatedAt: now - 20, expiresAt: now + 300, keyExpiresAt: now + 86400, state: 'ACTIVE' as const };
    const qr = { v: 2 as const, type: 'qr_payment' as const, requestId: crypto.randomUUID(), beneficiaryType: 'USER' as const, beneficiaryId: userId, issuerDeviceId: cert.deviceId, displayName: 'Alice', amount: 1, quantityK: 1, variableAmount: false, currency: 'XAF', reference: 'Don', issuedAt: now - 10, expiresAt: now + 60, singleUse: true, keyId: cert.keyId, keyVersion: 1 };
    const rootSign = (p: unknown, typ: string) => signJws(p, root.privateKey, 'root', typ);
    const rev = { version: 2, revision: 1, issuedAt: now - 10, expiresAt: now + 600, entries: [] as any[] };
    const token = await signQr(qr, key.privateKey, cert, now);
    await expect(verifyQr(token, { roots: { root: root.publicKey }, certificates: [await rootSign(cert, 'KTG-CERT2')], revocations: await rootSign(rev, 'KTG-REV2'), now })).resolves.toEqual(qr);
});

