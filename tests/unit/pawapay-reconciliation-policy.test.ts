import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableIsolatedPawaPaySandbox } from '../helpers/pawapay-sandbox-runtime.ts';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), key: vi.fn(), reopen: vi.fn(),
}));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../../src/application/services/pay/payment-provider-attempt-service.ts', () => ({
  paymentProviderAttemptService: { getPawaPayConfigurationKey: mocks.key },
}));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: { handleProviderAttemptFailure: mocks.reopen },
}));
const { pawaPayDepositService } = await import('../../src/application/services/pay/pawapay-deposit-service.ts');

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe('Reconciliation worker sandbox isolation', () => {
  it.each([false, true])('only recovers sandbox failed orders in an isolated opted-in worker: %s', async allowed => {
    if (allowed) enableIsolatedPawaPaySandbox();
    else vi.stubEnv('PAWAPAY_ALLOW_SANDBOX', undefined);
    mocks.query.mockResolvedValue({ rows: [{ order_id: 'order', provider_reference: 'deposit' }] });
    mocks.key.mockResolvedValue('KTG_CG_PAWAPAY_SANDBOX');
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    expect(await pawaPayDepositService.reconcile()).toBe(0);
    expect(mocks.reopen).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(query.mock.calls.every(([sql]) => !/^\s*(UPDATE|INSERT|DELETE)\b/.test(sql))).toBe(true);
  });
});
