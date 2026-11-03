import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  checkRateLimit: vi.fn(),
  sendTemplate: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.poolQuery, connect: mocks.connect },
}));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({
  redisAdapter: { checkRateLimit: mocks.checkRateLimit },
}));
vi.mock('../../src/application/services/resend-service.ts', () => ({
  emailService: { sendTemplate: mocks.sendTemplate },
}));

import {
  walletDebitAuthorizationService,
  WalletDebitAuthorizationAttemptsError,
  WalletDebitAuthorizationConflictError,
  WalletDebitAuthorizationExpiredError,
  WalletDebitAuthorizationNotFoundError,
  WalletDebitAuthorizationRateLimitError,
} from '../../src/application/services/pay/wallet-debit-authorization-service.ts';

const now = new Date();
const validOtp = '123456';
const salt = 'a'.repeat(64);
const validHash = createHash('sha256').update(`${salt}:${validOtp}`).digest('hex');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    payer_user_id: 'user-1',
    payer_party_id: null,
    operation_type: 'transfer',
    operation_id: 'transfer-1',
    amount: 1250,
    currency: 'XOF',
    payee_snapshot: { displayName: 'Recipient' },
    otp_hash: validHash,
    otp_salt: salt,
    lifecycle: 'issued',
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    attempts: 0,
    resend_count: 0,
    last_sent_at: null,
    approved_at: null,
    consumed_at: null,
    version: 1,
    ...overrides,
  };
}

describe('walletDebitAuthorizationService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.checkRateLimit.mockResolvedValue(true);
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.sendTemplate.mockResolvedValue(true);
  });

  it('expires an authorization before comparing its OTP', async () => {
    const expired = row({ expires_at: new Date(now.getTime() - 1_000).toISOString() });
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [expired] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(walletDebitAuthorizationService.verify(expired.id, validOtp, 'user-1'))
      .rejects.toBeInstanceOf(WalletDebitAuthorizationExpiredError);
    expect(mocks.poolQuery.mock.calls[1][0]).toContain("lifecycle = 'expired'");
  });

  it('revokes the authorization on the fifth wrong OTP attempt', async () => {
    const pending = row({ attempts: 4 });
    const revoked = row({ attempts: 5, lifecycle: 'revoked', version: 2 });
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [pending] })
      .mockResolvedValueOnce({ rows: [revoked] });

    await expect(walletDebitAuthorizationService.verify(pending.id, '000000', 'user-1'))
      .rejects.toBeInstanceOf(WalletDebitAuthorizationAttemptsError);
    expect(mocks.poolQuery.mock.calls[1][0]).toContain("WHEN attempts + 1 >= $1 THEN 'revoked'");
  });

  it('enforces the resend cooldown before generating or delivering another OTP', async () => {
    const issued = row({ last_sent_at: new Date().toISOString() });
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [issued] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(walletDebitAuthorizationService.issue({
      operationType: 'k_send', operationId: 'k_send-1', amount: 1250, currency: 'XOF',
      payeeSnapshot: { displayName: 'Recipient' },
    }, { userId: 'user-1', email: 'payer@example.test' })).rejects.toMatchObject({ code: 'RESEND_COOLDOWN' });

    expect(mocks.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('sends the OTP by email but never returns it from issuance', async () => {
    const created = row();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [created] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    const result = await walletDebitAuthorizationService.issue({
      operationType: 'k_send', operationId: 'k_send-1', amount: 1250, currency: 'XOF',
      payeeSnapshot: { displayName: 'Recipient' },
    }, { userId: 'user-1', email: 'payer@example.test', locale: 'en' });

    expect(result).toEqual(expect.objectContaining({ authorization: expect.any(Object), emailSent: true }));
    expect(result).not.toHaveProperty('otp');
    expect(mocks.sendTemplate).toHaveBeenCalledWith('walletDebitAuthorization', 'en', 'payer@example.test', expect.objectContaining({
      code: expect.stringMatching(/^\d{6}$/),
    }));
    expect(mocks.clientQuery.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
  });

  it('atomically approves once and consumes once', async () => {
    const issued = row();
    const approved = row({ lifecycle: 'approved', approved_at: new Date().toISOString(), version: 2 });
    const consumed = row({ lifecycle: 'consumed', approved_at: approved.approved_at, consumed_at: new Date().toISOString(), version: 3 });
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [issued] })
      .mockResolvedValueOnce({ rows: [approved] })
      .mockResolvedValueOnce({ rows: [approved] })
      .mockResolvedValueOnce({ rows: [consumed] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(walletDebitAuthorizationService.verify(issued.id, validOtp, 'user-1'))
      .resolves.toMatchObject({ lifecycle: 'approved' });
    await expect(walletDebitAuthorizationService.verify(issued.id, validOtp, 'user-1'))
      .rejects.toBeInstanceOf(WalletDebitAuthorizationConflictError);
    await expect(walletDebitAuthorizationService.consume(issued.id, 'user-1'))
      .resolves.toMatchObject({ lifecycle: 'consumed' });
    await expect(walletDebitAuthorizationService.consume(issued.id, 'user-1'))
      .rejects.toBeInstanceOf(WalletDebitAuthorizationConflictError);
    expect(mocks.poolQuery.mock.calls[1][0]).toContain("lifecycle = 'approved'");
    expect(mocks.poolQuery.mock.calls[3][0]).toContain("lifecycle = 'consumed'");
  });

  it('does not reveal whether another payer owns an authorization', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(walletDebitAuthorizationService.verify('00000000-0000-4000-8000-000000000001', validOtp, 'other-user'))
      .rejects.toBeInstanceOf(WalletDebitAuthorizationNotFoundError);
    expect(mocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining('payer_user_id = $2'), [
      '00000000-0000-4000-8000-000000000001', 'other-user',
    ]);
  });

  describe('email recipient resolution', () => {
    beforeEach(() => {
      mocks.poolQuery.mockReset();
      mocks.sendTemplate.mockReset().mockResolvedValue(true);
      mocks.checkRateLimit.mockReset().mockResolvedValue(true);
      // First issuance: BEGIN, advisory lock, expiry sweep, lookup, INSERT, COMMIT.
      mocks.clientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [row()] })
        .mockResolvedValueOnce({ rows: [] });
    });

    it('sends email to payment_otp_email if set and not empty', async () => {
      mocks.poolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', payment_otp_email: 'otp@example.com' }] })
        .mockResolvedValueOnce({ rows: [row()] });
      
      await walletDebitAuthorizationService.issue({
        operationType: 'k_send', operationId: 'k_send-1', amount: 1250, currency: 'XOF',
        payeeSnapshot: { displayName: 'Recipient' },
      }, { userId: 'user-1', email: 'default@example.com', locale: 'fr' });
      
      expect(mocks.sendTemplate).toHaveBeenCalledWith(
        'walletDebitAuthorization',
        'fr',
        'otp@example.com',  // Should use payment_otp_email
        expect.any(Object)
      );
    });

    it('sends email to default user email when payment_otp_email is empty/undefined', async () => {
      mocks.poolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'user-1', payment_otp_email: '' }] })
        .mockResolvedValueOnce({ rows: [row()] });
      
      await walletDebitAuthorizationService.issue({
        operationType: 'k_send', operationId: 'k_send-1', amount: 1250, currency: 'XOF',
        payeeSnapshot: { displayName: 'Recipient' },
      }, { userId: 'user-1', email: 'default@example.com', locale: 'en' });
      
      expect(mocks.sendTemplate).toHaveBeenCalledWith(
        'walletDebitAuthorization',
        'en',
        'default@example.com',  // Should use default email
        expect.any(Object)
      );
    });

    it('sends email to default user email when payment_otp_email is not set', async () => {
      mocks.poolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })  // No payment_otp_email field
        .mockResolvedValueOnce({ rows: [row()] });
      
      await walletDebitAuthorizationService.issue({
        operationType: 'k_send', operationId: 'k_send-1', amount: 1250, currency: 'XOF',
        payeeSnapshot: { displayName: 'Recipient' },
      }, { userId: 'user-1', email: 'default@example.com', locale: 'en' });
      
      expect(mocks.sendTemplate).toHaveBeenCalledWith(
        'walletDebitAuthorization',
        'en',
        'default@example.com',  // Should use default email
        expect.any(Object)
      );
    });
  });
});
