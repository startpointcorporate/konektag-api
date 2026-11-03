import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';

export interface UserApiKeyInfo {
  id: string;
  label: string;
  api_key: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface UserApiIdentity {
  keyId: string;
  user: {
    id: string;
    keycloak_id: string;
    username: string;
    email?: string;
    locale: string;
    state: string;
    role: string;
    profile_type: string;
    country: string;
    city: string;
    access_status: string;
  };
}

const PUBLIC_COLUMNS = 'id, label, api_key, created_at, expires_at, revoked_at, last_used_at';
const secretHash = (key: string, secret: string) =>
  createHash('sha256').update(key + ':' + secret).digest('hex');

export function parseUserApiAuthorization(header: string | null): { key: string; secret: string } | null {
  const match = header?.match(/^token (ktg_[a-f0-9]{32}):([a-f0-9]{64})$/i);
  return match ? { key: match[1], secret: match[2] } : null;
}

export const userApiKeyService = {
  async create(userId: string, label: string, expiresAt: string | null = null): Promise<UserApiKeyInfo & { api_secret: string }> {
    const key = 'ktg_' + randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const { rows } = await pool.query<UserApiKeyInfo>(
      `INSERT INTO konektag.user_api_keys(user_id, label, api_key, secret_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_COLUMNS}`,
      [userId, label, key, secretHash(key, secret), expiresAt],
    );
    // Only this response exposes the secret. Listing never selects its hash.
    return { ...rows[0], api_secret: secret };
  },

  async list(userId: string): Promise<UserApiKeyInfo[]> {
    const { rows } = await pool.query<UserApiKeyInfo>(
      `SELECT ${PUBLIC_COLUMNS} FROM konektag.user_api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  },

  async revoke(userId: string, id: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE konektag.user_api_keys SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [id, userId],
    );
    return result.rows.length === 1;
  },

  async authenticate(header: string | null): Promise<UserApiIdentity | null> {
    const credentials = parseUserApiAuthorization(header);
    if (!credentials) return null;
    // Read the user's current rights on every request. No role is copied to a key.
    const { rows: [row] } = await pool.query(
      `SELECT k.id AS key_id, k.secret_hash,
              u.id, u.keycloak_id, u.username, u.locale, u.state, u.role,
              u.profile_type, u.country, u.city, u.access_status, u.encrypted_data
       FROM konektag.user_api_keys k JOIN konektag.users u ON u.id = k.user_id
       WHERE k.api_key = $1 AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > now()) AND u.deleted_at IS NULL`,
      [credentials.key],
    );
    if (!row) return null;
    const expected = Buffer.from(row.secret_hash, 'hex');
    const actual = Buffer.from(secretHash(credentials.key, credentials.secret), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const { encryptionService } = await import('../../infrastructure/adapters/encryption-service.ts');
    const data = JSON.parse(encryptionService.decrypt(row.encrypted_data));
    const { key_id, secret_hash, encrypted_data, ...user } = row;
    if (typeof data.email === 'string') user.email = data.email;
    await pool.query(
      `UPDATE konektag.user_api_keys SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
      [key_id],
    );
    return { keyId: key_id, user };
  },
};
