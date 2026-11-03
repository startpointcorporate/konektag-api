import { randomUUID } from 'node:crypto';
import pool from '../infrastructure/database/pool.ts';
import { base64urlDecode, canonicalJson, signJws, verifyJws } from './shared/core02/crypto.ts';
import { PublicKeySchema, DeviceProofSchema, CertificateSchema, RevocationsSchema, assertTimeWindow } from './shared/core02/contracts.ts';
import type { PoolClient } from 'pg';
const seconds = (v: Date | string) => Math.floor(new Date(v).getTime() / 1000);
function policy(name: string, fallback: number, min: number, max: number) { const value = Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('POLICY_INVALID'); return value; }
function normalizedPublic(jwk: JsonWebKey) { return PublicKeySchema.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }); }
export async function signAuthority(payload: unknown, typ: string) {
    try {
        const kid = process.env.CORE02_SIGNING_KEY_ID, raw = process.env.CORE02_SIGNING_JWK;
        if (!kid || !raw || !/^[A-Za-z0-9_-]{1,80}$/.test(kid))
            throw new Error();
        const jwk = JSON.parse(raw);
        normalizedPublic(jwk);
        if (typeof jwk.d !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jwk.d))
            throw new Error();
        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        return await signJws(payload, key, kid, typ);
    }
    catch {
        throw new Error('AUTHORITY_UNAVAILABLE');
    }
}
export async function signedRevocations() {
    const { rows } = await pool.query('SELECT revision,key_id,device_id,revoked_at FROM konektag.core_key_revocations ORDER BY revision LIMIT 10001');
    if (rows.length > 10000)
        throw new Error('REVOCATION_CAPACITY');
    const now = Math.floor(Date.now() / 1000);
    // Count committed immutable entries: sequence allocation order is not commit order.
    return signAuthority(RevocationsSchema.parse({ version: 2, revision: rows.length, issuedAt: now, expiresAt: now + policy('CORE02_REVOCATION_TTL_SECONDS', 3600, 60, 3600), entries: rows.map(row => ({ keyId: row.key_id, deviceId: row.device_id, revokedAt: seconds(row.revoked_at) })) }), 'KTG-REV2');
}
async function merchantName(client: PoolClient, userId: string, merchantId: string | null) {
    if (!merchantId)
        return null;
    const { rows: [row] } = await client.query(`SELECT mp.business_name FROM konektag.merchant_profiles mp JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id=mp.id WHERE mp.id=$1 AND mm.user_id=$2 AND mm.status='active' AND mm.role IN ('owner','manager') AND mp.deleted_at IS NULL FOR SHARE OF mp,mm`, [merchantId, userId]);
    if (!row)
        throw new Error('MERCHANT_ACCESS_DENIED');
    return row.business_name as string;
}
/** Includes enrollment, renewal and fenced rotation; never grants a payment allowance. */
export async function enrollIdentity(userId: string, proofToken: string) {
    if (typeof proofToken !== 'string' || proofToken.length > 4096)
        throw new Error('PROOF_INVALID');
    const parts = proofToken.split('.');
    if (parts.length !== 3)
        throw new Error('PROOF_INVALID');
    const candidate = DeviceProofSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlDecode(parts[1]))));
    const publicKey = await crypto.subtle.importKey('jwk', candidate.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const proof = DeviceProofSchema.parse(await verifyJws(proofToken, publicKey, candidate.keyId, 'KTG-POP2'));
    const now = Math.floor(Date.now() / 1000);
    assertTimeWindow(proof.issuedAt, proof.expiresAt, now);
    if (proof.ownerUserId !== userId)
        throw new Error('OWNER_MISMATCH');
    const publicJwk = normalizedPublic(proof.publicKey);
    const certTtl = policy('CORE02_CERT_TTL_SECONDS', 86400, 60, 86400), keyTtl = policy('CORE02_KEY_TTL_SECONDS', 2592000, 86400, 2592000), overlap = Math.max(certTtl, policy('CORE02_OVERLAP_SECONDS', 86400, 60, 86400));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT id FROM konektag.users WHERE id=$1 FOR UPDATE', [userId]);
        if (!user.rowCount)
            throw new Error('OWNER_UNKNOWN');
        const name = await merchantName(client, userId, proof.merchantProfileId);
        const { rows: [device] } = await client.query('SELECT * FROM konektag.core_offline_devices WHERE id=$1 FOR UPDATE', [proof.deviceId]);
        if (device && (device.owner_user_id !== userId || device.state !== 'ACTIVE'))
            throw new Error('DEVICE_DENIED');
        const { rows: [existing] } = await client.query('SELECT * FROM konektag.core_device_keys WHERE key_id=$1 FOR UPDATE', [proof.keyId]);
        let version: number, keyExpiresAt: number;
        if (existing) {
            if (!device || existing.device_id !== proof.deviceId || existing.owner_user_id !== userId || canonicalJson(existing.public_key) !== canonicalJson(publicJwk) || existing.state !== 'ACTIVE')
                throw new Error('KEY_CONFLICT');
            version = Number(existing.version);
            keyExpiresAt = seconds(existing.expires_at);
            const expected = proof.action === 'enroll' ? 0 : proof.action === 'rotate' ? version - 1 : version;
            if (proof.expectedVersion !== expected || (proof.action === 'enroll' && version !== 1) || Number(device.key_version) !== version)
                throw new Error('VERSION_CONFLICT');
            if (keyExpiresAt <= now)
                throw new Error('KEY_EXPIRED');
            const { rows: [prior] } = await client.query(`SELECT token FROM konektag.core_device_certificates WHERE key_id=$1 AND merchant_profile_id IS NOT DISTINCT FROM $2::uuid AND expires_at>to_timestamp($3) ORDER BY expires_at DESC LIMIT 1`, [proof.keyId, proof.merchantProfileId, now + (proof.action === 'renew' ? 300 : 0)]);
            if (prior) {
                await client.query('COMMIT');
                return { certificate: prior.token, deviceId: proof.deviceId, keyId: proof.keyId, keyVersion: version, serverTime: now };
            }
        }
        else {
            if (proof.action === 'enroll') {
                if (device || proof.expectedVersion !== 0)
                    throw new Error('DEVICE_CONFLICT');
                const active = await client.query("SELECT 1 FROM konektag.core_offline_devices WHERE owner_user_id=$1 AND state='ACTIVE'", [userId]);
                if (active.rowCount)
                    throw new Error('DEVICE_ALREADY_ACTIVE');
                version = 1;
                await client.query(`INSERT INTO konektag.core_offline_devices(id,owner_user_id,public_key,key_version,state,activated_at) VALUES($1,$2,$3,1,'ACTIVE',to_timestamp($4))`, [proof.deviceId, userId, canonicalJson(publicJwk), now]);
            }
            else if (proof.action === 'rotate') {
                if (!device || Number(device.key_version) !== proof.expectedVersion)
                    throw new Error('VERSION_CONFLICT');
                const { rows: [old] } = await client.query("SELECT * FROM konektag.core_device_keys WHERE device_id=$1 AND state='ACTIVE' FOR UPDATE", [proof.deviceId]);
                if (!old || Number(old.version) !== proof.expectedVersion)
                    throw new Error('KEY_UNKNOWN');
                version = proof.expectedVersion + 1;
                await client.query("UPDATE konektag.core_device_keys SET state='RETIRING',retire_at=LEAST(expires_at,to_timestamp($2)) WHERE key_id=$1", [old.key_id, now + overlap]);
                await client.query('UPDATE konektag.core_offline_devices SET public_key=$2,key_version=$3 WHERE id=$1', [proof.deviceId, canonicalJson(publicJwk), version]);
            }
            else
                throw new Error('KEY_UNKNOWN');
            keyExpiresAt = now + keyTtl;
            await client.query(`INSERT INTO konektag.core_device_keys(key_id,device_id,owner_user_id,version,public_key,activated_at,expires_at,state) VALUES($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),'ACTIVE')`, [proof.keyId, proof.deviceId, userId, version, publicJwk, now, keyExpiresAt]);
        }
        const cert = CertificateSchema.parse({ version: 2, deviceId: proof.deviceId, ownerUserId: userId, keyId: proof.keyId, keyVersion: version, publicKey: publicJwk, merchantProfileId: proof.merchantProfileId, merchantName: name, usage: proof.merchantProfileId ? 'QR_PAYMENT' : 'DEVICE', activatedAt: now, expiresAt: Math.min(now + certTtl, keyExpiresAt), keyExpiresAt, state: 'ACTIVE' });
        const token = await signAuthority(cert, 'KTG-CERT2');
        await client.query(`INSERT INTO konektag.core_device_certificates(certificate_id,key_id,token,activated_at,expires_at,merchant_profile_id,usage) VALUES($1,$2,$3,to_timestamp($4),to_timestamp($5),$6,$7)`, [randomUUID(), proof.keyId, token, cert.activatedAt, cert.expiresAt, proof.merchantProfileId, cert.usage]);
        await client.query('COMMIT');
        return { certificate: token, deviceId: proof.deviceId, keyId: proof.keyId, keyVersion: version, serverTime: now };
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
export async function revokeDevice(userId: string, deviceId: string, keyId?: string) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM konektag.users WHERE id=$1 FOR UPDATE', [userId]);
        const { rows: [device] } = await client.query('SELECT * FROM konektag.core_offline_devices WHERE id=$1 AND owner_user_id=$2 FOR UPDATE', [deviceId, userId]);
        if (!device)
            throw new Error('DEVICE_DENIED');
        const { rows: keys } = await client.query('SELECT * FROM konektag.core_device_keys WHERE device_id=$1 FOR UPDATE', [deviceId]);
        const chosen = keyId ? keys.find(k => k.key_id === keyId) : null;
        if (keyId && !chosen)
            throw new Error('KEY_UNKNOWN');
        const all = !keyId || chosen.state === 'ACTIVE';
        // Serialize all publishers' writers before admission; retries consume no capacity.
        await client.query('LOCK TABLE konektag.core_key_revocations IN SHARE ROW EXCLUSIVE MODE');
        const selected = keys.filter(k => all || k.key_id === keyId);
        const { rows: [capacity] } = await client.query(`SELECT
            (SELECT count(*) FROM konektag.core_key_revocations)::int AS total,
            (SELECT count(*) FROM unnest($1::uuid[]) AS chosen(key_id)
             WHERE NOT EXISTS (SELECT 1 FROM konektag.core_key_revocations r WHERE r.key_id=chosen.key_id))::int AS added`,
            [selected.map(k => k.key_id)]);
        if (capacity.total + capacity.added > 10000)
            throw new Error('REVOCATION_CAPACITY');
        for (const key of selected) {
            await client.query("UPDATE konektag.core_device_keys SET state='REVOKED' WHERE key_id=$1", [key.key_id]);
            await client.query("INSERT INTO konektag.core_key_revocations(key_id,device_id,reason) VALUES($1,$2,'OWNER_REVOKED') ON CONFLICT(key_id) DO NOTHING", [key.key_id, deviceId]);
        }
        if (all)
            await client.query("UPDATE konektag.core_offline_devices SET state='REVOKED',revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [deviceId]);
        await client.query('COMMIT');
        return { revoked: true };
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
export async function identityBootstrap(userId: string, keyId?: string) {
    const { rows: devices } = await pool.query('SELECT id AS "deviceId",state,key_version AS "keyVersion" FROM konektag.core_offline_devices WHERE owner_user_id=$1', [userId]);
    const { rows: certificates } = keyId ? await pool.query("SELECT c.token FROM konektag.core_device_certificates c WHERE c.key_id=$1 AND c.usage='QR_PAYMENT' ORDER BY c.activated_at DESC", [keyId]) : await pool.query('SELECT c.token FROM konektag.core_device_certificates c JOIN konektag.core_device_keys k ON k.key_id=c.key_id WHERE k.owner_user_id=$1 ORDER BY c.activated_at DESC', [userId]);
    return { userId, devices, certificates: certificates.map(r => r.token), revocations: await signedRevocations() };
}
