import type { Pool, PoolClient } from 'pg';

export type UserKycGateResult = { verified: boolean; state: string };

export async function checkUserKycVerified(db: Pool | PoolClient, userId: string): Promise<UserKycGateResult> {
  const { rows: [user] } = await db.query(
    `SELECT u.state,
            EXISTS (
              SELECT 1
              FROM konektag.kyc_orders k
              WHERE k.user_id = u.id
                AND k.status = 'verified'
                AND k.verified_at IS NOT NULL
            ) AS has_verified_kyc
     FROM konektag.users u
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  );
  const state = user?.state ?? 'NOT_FOUND';

  // Onboarding state and KYC verification are separate concerns. A completed
  // account remains COMPLETED after KYC; the verified KYC order is authoritative.
  const verified = Boolean(user?.has_verified_kyc)
    || state === 'KYC_VALIDATED'
    || state === 'KYC_VERIFIED'
    || state === 'KYC_ENHANCED';

  return { verified, state };
}

export async function requireUserKycVerified(db: Pool | PoolClient, userId: string): Promise<void> {
  const result = await checkUserKycVerified(db, userId);
  if (!result.verified) throw new Error(`USER_KYC_REQUIRED:${result.state}`);
}
