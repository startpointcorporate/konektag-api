import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn(), connect: vi.fn() };
const mockClient = { query: vi.fn(), release: vi.fn() };
mockPool.connect.mockResolvedValue(mockClient);

vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

const mockCredit = vi.fn();
vi.mock('../../src/application/services/ledger-service.ts', () => ({
  ledgerService: { credit: mockCredit },
}));

vi.mock('../../src/application/services/exchange-rate-service.ts', () => ({
  exchangeRateService: { getRate: vi.fn().mockResolvedValue(1) },
}));

vi.mock('../../src/application/services/resend-service.ts', () => ({
  emailService: { sendTemplate: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/infrastructure/correlation-id.ts', () => ({
  getCorrelationId: () => 'corr-test-crypto',
}));

vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({
  encryptionService: { decrypt: vi.fn().mockReturnValue(JSON.stringify({ email: 'user@test.com', firstName: 'Jean' })) },
}));

let confirmCryptoRecharge: any;

beforeEach(async () => {
  vi.resetAllMocks();
  mockPool.connect.mockResolvedValue(mockClient);
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  const mod = await import('../../src/application/commands/admin/confirm-crypto-command.ts');
  confirmCryptoRecharge = mod.confirmCryptoRecharge;
});

const mockProjection = {
  id: 'proj-crypto-1',
  recharge_name: 'KTG-RECH-CRYPTO-001',
  keycloak_id: 'kc-user-1',
  requested_amount: 5000,
  requested_currency: 'XOF',
  recharge_status: 'pending',
  credited_amount: null,
  payment_method: 'crypto',
  payment_provider: 'USDT_TRC20',
  crypto_network: 'USDT_TRC20',
  crypto_address: 'TXYZ123456789',
  user_id: 'user-uuid-1',
};

describe('confirmCryptoRecharge', () => {
  it('rejects insufficient confirmations before any DB access', async () => {
    await expect(confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001',
      adminId: 'admin-1',
      transactionHash: '0xabc123',
      cryptoNetwork: 'USDT_TRC20',
      confirmations: 1,  // below MIN = 2
      amountReceived: 5000,
    })).rejects.toThrow('confirmations insuffisant');
  });

  it('confirms a pending Crypto recharge with sufficient confirmations', async () => {
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [mockProjection] }); // FOR UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // idempotent check
    mockCredit.mockResolvedValueOnce(undefined);
    mockClient.query.mockResolvedValueOnce(undefined); // admin_action
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'outbox-crypto-1' }] }); // outbox
    mockClient.query.mockResolvedValueOnce(undefined); // COMMIT

    mockPool.query.mockResolvedValueOnce({
      rows: [{ encrypted_data: 'encrypted', locale: 'fr' }],
    });

    const result = await confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001',
      adminId: 'admin-1',
      transactionHash: '0xabc123def456',
      cryptoNetwork: 'USDT_TRC20',
      confirmations: 3,
      amountReceived: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.rechargeName).toBe('KTG-RECH-CRYPTO-001');

    // Verify ledger.credit was called with the client
    expect(mockCredit).toHaveBeenCalledWith(
      expect.objectContaining({ documentRef: 'KTG-RECH-CRYPTO-001' }),
      mockClient,
    );
  });

  it('rejects non-crypto recharge', async () => {
    const cardProj = { ...mockProjection, payment_method: 'card' };
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [cardProj] });
    mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001', adminId: 'admin-1',
      transactionHash: '0xabc', cryptoNetwork: 'USDT_TRC20',
      confirmations: 3, amountReceived: 5000,
    })).rejects.toThrow('pas la cryptomonnaie');
  });

  it('rejects wrong crypto network', async () => {
    const btcProj = { ...mockProjection, crypto_network: 'BTC' };
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [btcProj] }); // FOR UPDATE
    mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001', adminId: 'admin-1',
      transactionHash: '0xabc', cryptoNetwork: 'USDT_TRC20',  // wrong! expected BTC
      confirmations: 3, amountReceived: 5000,
    })).rejects.toThrow('ne correspond pas');
  });

  it('rejects non-pending recharge', async () => {
    const confirmedProj = { ...mockProjection, recharge_status: 'confirmed' };
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [confirmedProj] });
    mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001', adminId: 'admin-1',
      transactionHash: '0xabc', cryptoNetwork: 'USDT_TRC20',
      confirmations: 3, amountReceived: 5000,
    })).rejects.toThrow('d\u00E9j\u00E0');
  });

  it('is idempotent when ledger already credited', async () => {
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [mockProjection] }); // FOR UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [{ amount: 5000, currency: 'XOF' }] }); // existing credit
    mockClient.query.mockResolvedValueOnce(undefined); // COMMIT

    const result = await confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001', adminId: 'admin-1',
      transactionHash: '0xabc', cryptoNetwork: 'USDT_TRC20',
      confirmations: 3, amountReceived: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.previousStatus).toBe('pending');
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it('throws 404 for non-existent recharge', async () => {
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // FOR UPDATE → empty
    mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(confirmCryptoRecharge({
      rechargeName: 'NONEXISTENT', adminId: 'admin-1',
      transactionHash: '0xabc', cryptoNetwork: 'USDT_TRC20',
      confirmations: 3, amountReceived: 5000,
    })).rejects.toThrow('introuvable');
  });

  it('rolls back fully on error', async () => {
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [mockProjection] });
    mockClient.query.mockResolvedValueOnce({ rows: [] }); // idempotent
    mockCredit.mockResolvedValueOnce(undefined);
    mockClient.query.mockRejectedValueOnce(new Error('DB error')); // admin_action fails
    mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001', adminId: 'admin-1',
      transactionHash: '0xabc', cryptoNetwork: 'USDT_TRC20',
      confirmations: 3, amountReceived: 5000,
    })).rejects.toThrow('DB error');

    expect(mockClient.query.mock.calls.some((c: any) => String(c[0]) === 'ROLLBACK')).toBe(true);
  });

  it('accepts 2 confirmations (minimum)', async () => {
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [mockProjection] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockCredit.mockResolvedValueOnce(undefined);
    mockClient.query.mockResolvedValueOnce(undefined); // admin_action
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'outbox-2' }] });
    mockClient.query.mockResolvedValueOnce(undefined); // COMMIT

    mockPool.query.mockResolvedValueOnce({
      rows: [{ encrypted_data: 'encrypted', locale: 'fr' }],
    });

    const result = await confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001', adminId: 'admin-1',
      transactionHash: '0xabc', cryptoNetwork: 'USDT_TRC20',
      confirmations: 2,
      amountReceived: 5000,
    });
    expect(result.success).toBe(true);
  });

  it('stores transaction hash and network in admin action payload', async () => {
    mockClient.query.mockResolvedValueOnce(undefined); // BEGIN
    mockClient.query.mockResolvedValueOnce(undefined); // lock_timeout
    mockClient.query.mockResolvedValueOnce({ rows: [mockProjection] });
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    mockCredit.mockResolvedValueOnce(undefined);
    mockClient.query.mockResolvedValueOnce(undefined); // admin_action
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: 'outbox-3' }] });
    mockClient.query.mockResolvedValueOnce(undefined); // COMMIT

    mockPool.query.mockResolvedValueOnce({
      rows: [{ encrypted_data: 'encrypted', locale: 'fr' }],
    });

    await confirmCryptoRecharge({
      rechargeName: 'KTG-RECH-CRYPTO-001', adminId: 'admin-1',
      transactionHash: '0xabc123def456',
      cryptoNetwork: 'USDT_TRC20',
      confirmations: 5,
      amountReceived: 5000,
    });

    const adminActionCall = mockClient.query.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO konektag.admin_actions')
    );
    const payload = JSON.parse(adminActionCall![1][3]);
    expect(payload.transactionHash).toBe('0xabc123def456');
    expect(payload.cryptoNetwork).toBe('USDT_TRC20');
    expect(payload.confirmations).toBe(5);
  });
});
