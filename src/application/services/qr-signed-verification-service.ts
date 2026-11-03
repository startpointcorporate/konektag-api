import pool from '../../infrastructure/database/pool.ts';
import { verifyQr } from '../shared/core02/qr.ts';
import { signedRevocations } from '../core02-identity-service.ts';

async function trustedRoots(): Promise<Record<string, CryptoKey>> {
  const raw = process.env.PUBLIC_CORE02_TRUST_ROOTS || '{}';
  const source = JSON.parse(raw) as Record<string, JsonWebKey>;
  const roots: Record<string, CryptoKey> = Object.create(null);
  for (const [kid, jwk] of Object.entries(source)) {
    roots[kid] = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  return roots;
}

export async function verifySignedQrServer(token: string) {
  const { rows } = await pool.query<{ token: string }>(
    `SELECT token FROM konektag.core_device_certificates
     WHERE expires_at > now() ORDER BY activated_at DESC`,
  );
  const qr = await verifyQr(token, {
    roots: await trustedRoots(),
    certificates: rows.map(row => row.token),
    revocations: await signedRevocations(),
    now: Math.floor(Date.now() / 1000),
  });
  return qr;
}
