import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { emailService } from '../resend-service.ts';
import { redisAdapter } from '../../../infrastructure/adapters/redis-adapter.ts';
import pool from '../../../infrastructure/database/pool.ts';

const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;

export type WalletDebitOperationType = 'recharge' | 'qr_pay' | 'k_send' | 'api_payment' | 'payment_link';
export type WalletDebitAuthorizationLifecycle = 'issued' | 'approved' | 'consumed' | 'expired' | 'revoked';

export interface WalletDebitPayeeSnapshot {
  displayName: string;
  reference?: string;
  maskedIdentifier?: string;
}

export interface WalletDebitAuthorizationPayer {
  userId: string;
  email: string;
  locale?: string;
  displayName?: string;
}

export interface IssueWalletDebitAuthorizationInput {
  operationType: WalletDebitOperationType;
  operationId: string;
  amount: number;
  currency: string;
  payeeSnapshot: WalletDebitPayeeSnapshot;
}

interface AuthorizationRow {
  id: string;
  payer_user_id: string | null;
  payer_party_id: string | null;
  operation_type: WalletDebitOperationType;
  operation_id: string;
  amount: number | string;
  currency: string;
  payee_snapshot: WalletDebitPayeeSnapshot;
  otp_hash: string;
  otp_salt: string;
  lifecycle: WalletDebitAuthorizationLifecycle;
  expires_at: string | Date;
  attempts: number;
  resend_count: number;
  last_sent_at: string | Date | null;
  approved_at: string | Date | null;
  consumed_at: string | Date | null;
  version: number;
}

type DatabaseClient = {
  query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  release: () => void;
};

export class WalletDebitAuthorizationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

export class WalletDebitAuthorizationNotFoundError extends WalletDebitAuthorizationError {
  constructor() { super('AUTHORIZATION_NOT_FOUND'); }
}

export class WalletDebitAuthorizationConflictError extends WalletDebitAuthorizationError {
  constructor(code = 'AUTHORIZATION_CONFLICT') { super(code); }
}

export class WalletDebitAuthorizationExpiredError extends WalletDebitAuthorizationError {
  constructor() { super('AUTHORIZATION_EXPIRED'); }
}

export class WalletDebitAuthorizationAttemptsError extends WalletDebitAuthorizationError {
  constructor() { super('OTP_MAX_ATTEMPTS'); }
}

export class WalletDebitAuthorizationRateLimitError extends WalletDebitAuthorizationError {
  constructor(code = 'RATE_LIMITED') { super(code); }
}

export class WalletDebitAuthorizationDeliveryError extends WalletDebitAuthorizationError {
  constructor() { super('OTP_DELIVERY_FAILED'); }
}

function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashOtp(otp: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${otp}`).digest('hex');
}

function equalOtp(otp: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOtp(otp, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isExpired(row: AuthorizationRow): boolean {
  return new Date(row.expires_at).getTime() <= Date.now();
}

function sameSnapshot(left: WalletDebitPayeeSnapshot, right: WalletDebitPayeeSnapshot): boolean {
  return left.displayName === right.displayName
    && left.reference === right.reference
    && left.maskedIdentifier === right.maskedIdentifier;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function toPublicAuthorization(row: AuthorizationRow) {
  return {
    id: row.id,
    operationType: row.operation_type,
    operationId: row.operation_id,
    amount: Number(row.amount),
    currency: row.currency,
    payeeSnapshot: row.payee_snapshot,
    lifecycle: row.lifecycle,
    expiresAt: new Date(row.expires_at).toISOString(),
    attempts: Number(row.attempts),
    resendCount: Number(row.resend_count),
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : null,
  };
}

async function rateLimit(key: string, maxRequests: number, windowSec: number): Promise<void> {
  try {
    const allowed = await redisAdapter.checkRateLimit(key, maxRequests, windowSec);
    if (!allowed) throw new WalletDebitAuthorizationRateLimitError();
  } catch (error) {
    if (error instanceof WalletDebitAuthorizationRateLimitError) throw error;
    // OTP issuance and verification must not proceed without their abuse control.
    throw new WalletDebitAuthorizationRateLimitError('RATE_LIMIT_UNAVAILABLE');
  }
}

async function markEmailDelivery(id: string, delivered: boolean): Promise<void> {
  await pool.query(
    `UPDATE konektag.wallet_debit_authorizations
     SET email_delivery_status = $2,
         updated_at = now(),
         version = version + 1
     WHERE id = $1 AND lifecycle = 'issued'`,
    [id, delivered ? 'sent' : 'failed'],
  );
}

export const walletDebitAuthorizationService = {
  async issue(input: IssueWalletDebitAuthorizationInput, payer: WalletDebitAuthorizationPayer) {
    if (!payer.email) throw new WalletDebitAuthorizationError('PAYER_EMAIL_REQUIRED');
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new WalletDebitAuthorizationError('INVALID_AMOUNT');
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new WalletDebitAuthorizationError('INVALID_CURRENCY');
    if (!['recharge', 'qr_pay', 'k_send', 'api_payment', 'payment_link'].includes(input.operationType)
      || typeof input.operationId !== 'string' || input.operationId.trim().length === 0 || input.operationId.length > 255) {
      throw new WalletDebitAuthorizationError('INVALID_OPERATION');
    }
    if (!input.payeeSnapshot || typeof input.payeeSnapshot.displayName !== 'string'
      || input.payeeSnapshot.displayName.trim().length === 0 || input.payeeSnapshot.displayName.length > 200) {
      throw new WalletDebitAuthorizationError('INVALID_PAYEE_SNAPSHOT');
    }

    await rateLimit(`wallet-debit-authorization:issue:${payer.userId}`, 5, 15 * 60);

    const client = await pool.connect() as unknown as DatabaseClient;
    let authorization: AuthorizationRow;
    let otp: string | null = null;
    try {
      await client.query('BEGIN');
      // Serialize first issuance too: a row lock alone cannot protect an absent row.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`wallet-debit:${input.operationType}:${input.operationId}:${payer.userId}`],
      );
      await client.query(
        `UPDATE konektag.wallet_debit_authorizations
         SET lifecycle = 'expired', updated_at = now(), version = version + 1
         WHERE operation_type = $1 AND operation_id = $2 AND payer_user_id = $3
           AND lifecycle IN ('issued', 'approved') AND expires_at <= now()`,
        [input.operationType, input.operationId, payer.userId],
      );
      const { rows } = await client.query<AuthorizationRow>(
        `SELECT * FROM konektag.wallet_debit_authorizations
         WHERE operation_type = $1 AND operation_id = $2 AND payer_user_id = $3
           AND lifecycle IN ('issued', 'approved')
         FOR UPDATE`,
        [input.operationType, input.operationId, payer.userId],
      );
      const existing = rows[0];
      if (existing?.lifecycle === 'approved') {
        await client.query('COMMIT');
        return { authorization: toPublicAuthorization(existing), emailSent: false };
      }

      if (existing) {
        if (Number(existing.amount) !== input.amount || existing.currency !== input.currency
          || !sameSnapshot(existing.payee_snapshot, input.payeeSnapshot)) {
          throw new WalletDebitAuthorizationConflictError('AUTHORIZATION_DETAILS_IMMUTABLE');
        }
        if (existing.last_sent_at
          && Date.now() - new Date(existing.last_sent_at).getTime() < RESEND_COOLDOWN_MS) {
          throw new WalletDebitAuthorizationRateLimitError('RESEND_COOLDOWN');
        }
        if (Number(existing.resend_count) >= MAX_RESENDS) {
          throw new WalletDebitAuthorizationRateLimitError('RESEND_LIMIT');
        }
      }

      otp = generateOtp();
      const salt = randomBytes(32).toString('hex');
      const otpHash = hashOtp(otp, salt);
      if (existing) {
        const { rows: updated } = await client.query<AuthorizationRow>(
          `UPDATE konektag.wallet_debit_authorizations
           SET otp_hash = $1, otp_salt = $2, expires_at = now() + interval '5 minutes',
               attempts = 0, resend_count = resend_count + 1, last_sent_at = now(),
               email_delivery_status = 'pending', updated_at = now(), updated_by = $3,
               version = version + 1
           WHERE id = $4 AND lifecycle = 'issued' AND version = $5
           RETURNING *`,
          [otpHash, salt, payer.userId, existing.id, existing.version],
        );
        authorization = updated[0]!;
      } else {
        const { rows: inserted } = await client.query<AuthorizationRow>(
          `INSERT INTO konektag.wallet_debit_authorizations (
             payer_user_id, operation_type, operation_id, amount, currency, payee_snapshot,
             otp_hash, otp_salt, expires_at, last_sent_at, created_by, updated_by
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now() + interval '5 minutes', now(), $1, $1)
           RETURNING *`,
          [payer.userId, input.operationType, input.operationId, input.amount, input.currency,
            JSON.stringify(input.payeeSnapshot), otpHash, salt],
        );
        authorization = inserted[0]!;
      }
      if (!authorization) throw new WalletDebitAuthorizationConflictError();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // Resolve email: payment_otp_email override or fallback to user's main email
    let resolvedEmail = payer.email;
    if (payer.userId) {
      try {
        const { rows: [userRow] } = await pool.query(
          `SELECT payment_otp_email FROM konektag.users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
          [payer.userId]
        );
        if (userRow && userRow.payment_otp_email && userRow.payment_otp_email.trim() !== '') {
          resolvedEmail = userRow.payment_otp_email;
        }
      } catch (error) {
        // If we fail to get the user details, fallback to the default email
        console.warn(`Failed to fetch payment_otp_email for user ${payer.userId}:`, error);
        // Keep using payer.email as fallback
      }
    }

    const language = payer.locale === 'en' ? 'en' : 'fr';
    const delivered = await emailService.sendTemplate('walletDebitAuthorization', language, resolvedEmail, {
      firstName: escapeHtml(payer.displayName ?? ''),
      code: otp!,
      amount: String(input.amount),
      currency: input.currency,
      payeeName: escapeHtml(input.payeeSnapshot.displayName),
      currentYear: new Date().getFullYear().toString(),
    }).catch(() => false);
    await markEmailDelivery(authorization.id, delivered);
    if (!delivered) throw new WalletDebitAuthorizationDeliveryError();
    return { authorization: toPublicAuthorization(authorization), emailSent: true };
  },

  async verify(authorizationId: string, otp: string, payerUserId: string) {
    await rateLimit(`wallet-debit-authorization:verify:${payerUserId}:${authorizationId}`, 10, 5 * 60);
    const { rows } = await pool.query<AuthorizationRow>(
      `SELECT * FROM konektag.wallet_debit_authorizations
       WHERE id = $1 AND payer_user_id = $2`,
      [authorizationId, payerUserId],
    );
    const authorization = rows[0];
    if (!authorization) throw new WalletDebitAuthorizationNotFoundError();
    if (authorization.lifecycle === 'consumed') {
      throw new WalletDebitAuthorizationConflictError('AUTHORIZATION_CONSUMED');
    }
    if (authorization.lifecycle === 'revoked' || Number(authorization.attempts) >= MAX_ATTEMPTS) {
      throw new WalletDebitAuthorizationAttemptsError();
    }
    if (authorization.lifecycle !== 'issued') throw new WalletDebitAuthorizationConflictError('AUTHORIZATION_NOT_ISSUED');
    if (isExpired(authorization)) {
      await pool.query(
        `UPDATE konektag.wallet_debit_authorizations
         SET lifecycle = 'expired', updated_at = now(), version = version + 1
         WHERE id = $1 AND payer_user_id = $2 AND lifecycle = 'issued'
           AND version = $3 AND expires_at <= now()`,
        [authorization.id, payerUserId, authorization.version],
      );
      throw new WalletDebitAuthorizationExpiredError();
    }

    if (!equalOtp(otp, authorization.otp_salt, authorization.otp_hash)) {
      const { rows: updated } = await pool.query<AuthorizationRow>(
        `UPDATE konektag.wallet_debit_authorizations
         SET attempts = attempts + 1,
             lifecycle = CASE WHEN attempts + 1 >= $1 THEN 'revoked' ELSE lifecycle END,
             updated_at = now(), version = version + 1
         WHERE id = $2 AND payer_user_id = $3 AND lifecycle = 'issued'
           AND version = $4 AND expires_at > now() AND attempts < $1
         RETURNING *`,
        [MAX_ATTEMPTS, authorization.id, payerUserId, authorization.version],
      );
      if (!updated[0]) throw new WalletDebitAuthorizationConflictError();
      if (updated[0].lifecycle === 'revoked') throw new WalletDebitAuthorizationAttemptsError();
      throw new WalletDebitAuthorizationError('OTP_INVALID');
    }

    const { rows: approved } = await pool.query<AuthorizationRow>(
      `UPDATE konektag.wallet_debit_authorizations
       SET lifecycle = 'approved', approved_at = now(), updated_at = now(),
           updated_by = $1, version = version + 1
       WHERE id = $2 AND payer_user_id = $1 AND lifecycle = 'issued'
         AND version = $3 AND expires_at > now()
       RETURNING *`,
      [payerUserId, authorization.id, authorization.version],
    );
    if (!approved[0]) throw new WalletDebitAuthorizationConflictError();
    return toPublicAuthorization(approved[0]);
  },

  async verifyForOperation(
    client: Pick<DatabaseClient, 'query'>,
    authorizationId: string,
    otp: string,
    payerUserId: string,
    operationType: WalletDebitOperationType,
    operationId: string,
  ) {
    await rateLimit(`wallet-debit-authorization:verify:${payerUserId}:${authorizationId}`, 10, 5 * 60);
    const { rows } = await client.query<AuthorizationRow>(
      `SELECT * FROM konektag.wallet_debit_authorizations
       WHERE id = $1 AND payer_user_id = $2 AND operation_type = $3 AND operation_id = $4
       FOR UPDATE`,
      [authorizationId, payerUserId, operationType, operationId],
    );
    const authorization = rows[0];
    if (!authorization) throw new WalletDebitAuthorizationNotFoundError();
    if (authorization.lifecycle === 'revoked' || Number(authorization.attempts) >= MAX_ATTEMPTS) {
      throw new WalletDebitAuthorizationAttemptsError();
    }
    if (authorization.lifecycle !== 'issued') {
      throw new WalletDebitAuthorizationConflictError('AUTHORIZATION_NOT_ISSUED');
    }
    if (isExpired(authorization)) {
      await client.query(
        `UPDATE konektag.wallet_debit_authorizations
         SET lifecycle = 'expired', updated_at = now(), version = version + 1
         WHERE id = $1 AND lifecycle = 'issued' AND version = $2 AND expires_at <= now()`,
        [authorization.id, authorization.version],
      );
      throw new WalletDebitAuthorizationExpiredError();
    }
    if (!equalOtp(otp, authorization.otp_salt, authorization.otp_hash)) {
      const { rows: updated } = await client.query<AuthorizationRow>(
        `UPDATE konektag.wallet_debit_authorizations
         SET attempts = attempts + 1,
             lifecycle = CASE WHEN attempts + 1 >= $1 THEN 'revoked' ELSE lifecycle END,
             updated_at = now(), version = version + 1
         WHERE id = $2 AND lifecycle = 'issued' AND version = $3 AND expires_at > now() AND attempts < $1
         RETURNING *`,
        [MAX_ATTEMPTS, authorization.id, authorization.version],
      );
      if (!updated[0]) throw new WalletDebitAuthorizationConflictError();
      if (updated[0].lifecycle === 'revoked') throw new WalletDebitAuthorizationAttemptsError();
      throw new WalletDebitAuthorizationError('OTP_INVALID');
    }
    const { rows: approved } = await client.query<AuthorizationRow>(
      `UPDATE konektag.wallet_debit_authorizations
       SET lifecycle = 'approved', approved_at = now(), updated_at = now(), updated_by = $1,
           version = version + 1
       WHERE id = $2 AND lifecycle = 'issued' AND version = $3 AND expires_at > now()
       RETURNING *`,
      [payerUserId, authorization.id, authorization.version],
    );
    if (!approved[0]) throw new WalletDebitAuthorizationConflictError();
    return toPublicAuthorization(approved[0]);
  },

  // API checkout verification is intentionally scoped by the server-owned order ID.
  // The caller holds the order and reservation transaction while this runs.
  async verifyApiPayment(
    client: Pick<DatabaseClient, 'query'>,
    operationId: string,
    otp: string,
    payerUserId: string,
  ) {
    await rateLimit(`wallet-debit-authorization:verify:${payerUserId}:${operationId}`, 10, 5 * 60);
    const { rows } = await client.query<AuthorizationRow>(
      `SELECT * FROM konektag.wallet_debit_authorizations
       WHERE operation_type = 'api_payment' AND operation_id = $1 AND payer_user_id = $2
       FOR UPDATE`,
      [operationId, payerUserId],
    );
    const authorization = rows[0];
    if (!authorization) throw new WalletDebitAuthorizationNotFoundError();
    if (authorization.lifecycle === 'revoked' || Number(authorization.attempts) >= MAX_ATTEMPTS) {
      throw new WalletDebitAuthorizationAttemptsError();
    }
    if (authorization.lifecycle !== 'issued') {
      throw new WalletDebitAuthorizationConflictError('AUTHORIZATION_NOT_ISSUED');
    }
    if (isExpired(authorization)) {
      await client.query(
        `UPDATE konektag.wallet_debit_authorizations
         SET lifecycle = 'expired', updated_at = now(), version = version + 1
         WHERE id = $1 AND lifecycle = 'issued' AND version = $2 AND expires_at <= now()`,
        [authorization.id, authorization.version],
      );
      throw new WalletDebitAuthorizationExpiredError();
    }
    if (!equalOtp(otp, authorization.otp_salt, authorization.otp_hash)) {
      const { rows: updated } = await client.query<AuthorizationRow>(
        `UPDATE konektag.wallet_debit_authorizations
         SET attempts = attempts + 1,
             lifecycle = CASE WHEN attempts + 1 >= $1 THEN 'revoked' ELSE lifecycle END,
             updated_at = now(), version = version + 1
         WHERE id = $2 AND lifecycle = 'issued' AND version = $3 AND expires_at > now() AND attempts < $1
         RETURNING *`,
        [MAX_ATTEMPTS, authorization.id, authorization.version],
      );
      if (!updated[0]) throw new WalletDebitAuthorizationConflictError();
      if (updated[0].lifecycle === 'revoked') throw new WalletDebitAuthorizationAttemptsError();
      throw new WalletDebitAuthorizationError('OTP_INVALID');
    }
    const { rows: approved } = await client.query<AuthorizationRow>(
      `UPDATE konektag.wallet_debit_authorizations
       SET lifecycle = 'approved', approved_at = now(), updated_at = now(), updated_by = $1,
           version = version + 1
       WHERE id = $2 AND lifecycle = 'issued' AND version = $3 AND expires_at > now()
       RETURNING *`,
      [payerUserId, authorization.id, authorization.version],
    );
    if (!approved[0]) throw new WalletDebitAuthorizationConflictError();
    return toPublicAuthorization(approved[0]);
  },

  async consume(
    authorizationId: string,
    payerUserId: string,
    transactionClient?: Pick<DatabaseClient, 'query'>,
  ) {
    const client = transactionClient ?? pool;
    const { rows } = await client.query<AuthorizationRow>(
      `UPDATE konektag.wallet_debit_authorizations
       SET lifecycle = 'consumed', consumed_at = now(), updated_at = now(),
           updated_by = $1, version = version + 1
       WHERE id = $2 AND payer_user_id = $1 AND lifecycle = 'approved' AND expires_at > now()
       RETURNING *`,
      [payerUserId, authorizationId],
    );
    if (!rows[0]) throw new WalletDebitAuthorizationConflictError('AUTHORIZATION_NOT_CONSUMABLE');
    return toPublicAuthorization(rows[0]);
  },
};
