import pool from '../../infrastructure/database/pool.ts';
import { createHash, randomBytes } from 'crypto';

const KEY_PREFIXES = {
  sandbox: { secret: 'sk_test_', public: 'pk_test_' },
  live: { secret: 'sk_live_', public: 'pk_live_' },
} as const;

export interface ApiKeyRow {
  id: string;
  merchant_profile_id: string;
  public_key: string;
  secret_key_hash: string;
  environment: 'sandbox' | 'live';
  is_revoked: boolean;
  revoked_at: string | null;
  created_at: string;
}

export interface KeyGenResult {
  publicKey: string;
  secretKey: string;
  environment: 'sandbox' | 'live';
}

export interface MerchantIdentity {
  merchantId: string;
  merchantProfileId: string;
  environment: 'sandbox' | 'live';
}

function generateKey(env: 'sandbox' | 'live'): { publicKey: string; secretKey: string; secretHash: string } {
  const raw = randomBytes(24).toString('base64url');
  const prefixes = KEY_PREFIXES[env];
  const secretKey = prefixes.secret + raw;
  const publicKey = prefixes.public + raw;
  const secretHash = createHash('sha256').update(secretKey).digest('hex');
  return { publicKey, secretKey, secretHash };
}

export const merchantApiKeyService = {
  async createKey(merchantProfileId: string, env: 'sandbox' | 'live'): Promise<KeyGenResult> {
    const { publicKey, secretKey, secretHash } = generateKey(env);
    await pool.query(
      `INSERT INTO konektag.merchant_api_keys (merchant_profile_id, public_key, secret_key_hash, environment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (merchant_profile_id, environment) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           secret_key_hash = EXCLUDED.secret_key_hash,
           is_revoked = FALSE,
           revoked_at = NULL,
           created_at = now()`,
      [merchantProfileId, publicKey, secretHash, env]
    );

    return { publicKey, secretKey, environment: env };
  },

  async validateApiKey(rawKey: string): Promise<MerchantIdentity | null> {
    if (!rawKey || (!rawKey.startsWith('sk_live_') && !rawKey.startsWith('sk_test_'))) return null;
    const env: 'sandbox' | 'live' = rawKey.startsWith('sk_test_') ? 'sandbox' : 'live';
    const hashed = createHash('sha256').update(rawKey).digest('hex');

    const { rows } = await pool.query<{ merchant_profile_id: string }>(
      `SELECT merchant_profile_id FROM konektag.merchant_api_keys
       WHERE secret_key_hash = $1 AND environment = $2 AND NOT is_revoked
       LIMIT 1`,
      [hashed, env]
    );
    if (rows.length === 0) return null;

    const { rows: profiles } = await pool.query<{ id: string }>(
      `SELECT id FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`,
      [rows[0].merchant_profile_id]
    );
    if (profiles.length === 0) return null;

    return { merchantId: profiles[0].id, merchantProfileId: profiles[0].id, environment: env };
  },

  async getKeyInfo(merchantProfileId: string): Promise<ApiKeyRow[]> {
    const { rows } = await pool.query<ApiKeyRow>(
      `SELECT id, merchant_profile_id, public_key, environment, is_revoked, revoked_at, created_at
       FROM konektag.merchant_api_keys
       WHERE merchant_profile_id = $1 AND NOT is_revoked
       ORDER BY environment, created_at DESC`,
      [merchantProfileId]
    );
    return rows;
  },

  async revokeKey(merchantProfileId: string, env: 'sandbox' | 'live'): Promise<void> {
    await pool.query(
      `UPDATE konektag.merchant_api_keys SET is_revoked = TRUE, revoked_at = now()
       WHERE merchant_profile_id = $1 AND environment = $2 AND NOT is_revoked`,
      [merchantProfileId, env]
    );
  },
};
