import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  query: vi.fn(),
  getOrder: vi.fn(),
}));
vi.mock('../../src/application/services/merchant-api-key-service.ts', () => ({
  merchantApiKeyService: { validateApiKey: mocks.validateApiKey },
}));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.query },
}));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: { getOrder: mocks.getOrder },
}));
import { GET } from '../../src/api/routes/pay/payments/by-reference.ts';

const call = (reference = 'ERP-SINV-0001', key = 'sk_test_example') => {
  const url = new URL('https://example.test/api/pay/payments/by-reference');
  if (reference) url.searchParams.set('transaction_id', reference);
  return GET({
    request: new Request(url, { headers: { authorization: 'Bearer ' + key } }),
    url,
  } as any);
};

describe('Merchant payment lookup by reference (additive ERP integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiKey.mockResolvedValue({ merchantProfileId: 'merchant-1', environment: 'sandbox' });
    mocks.query.mockResolvedValue({ rows: [{ id: 'payment-1' }] });
    mocks.getOrder.mockResolvedValue({ id: 'payment-1', state: 'paid', merchantTransactionId: 'ERP-SINV-0001' });
  });

  it('refuses missing and invalid API keys without reading orders', async () => {
    mocks.validateApiKey.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('requires a nonempty transaction reference', async () => {
    const response = await call('');
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('scopes reference lookup to merchant AND key environment', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('merchant_profile_id = $1 AND environment = $2'),
      ['merchant-1', 'sandbox', 'ERP-SINV-0001'],
    );
    expect(mocks.getOrder).toHaveBeenCalledWith('payment-1', { merchantProfileId: 'merchant-1' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ order: expect.objectContaining({ state: 'paid' }) });
  });

  it('does not reveal another merchant payment or checkout token', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await call();
    expect(response.status).toBe(404);
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('token');
  });

  it('does not expose backend exceptions', async () => {
    mocks.query.mockRejectedValue(new Error('database details'));
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'SERVER_ERROR' });
  });
});
