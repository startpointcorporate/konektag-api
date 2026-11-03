import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), release: vi.fn(), access: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: {
  query: mocks.query, connect: mocks.connect,
} }));
vi.mock('../../src/application/services/backoffice-permission-service.ts', () => ({
  requireBackofficePermission: () => mocks.access,
  forbiddenResponse: () => Response.json({ error: 'FORBIDDEN' }, { status: 403 }),
}));

import { POST } from '../../src/api/routes/admin/merchants/[id]/pro-activation.ts';
import { MerchantProSubscriptionService } from '../../src/application/services/merchant-pro-subscription-service.ts';

describe('initial Pro payment after central approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ authorized: true, user: { role: 'admin' } });
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM konektag.merchant_profiles')) return { rows: [{ id: 'merchant' }] };
      if (sql.includes('FROM konektag.merchant_pro_subscriptions')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
  });

  it('returns a payment link and does not activate before payment', async () => {
    const response = await POST({ locals: { user: { id: 'central-admin' } }, params: { id: 'merchant' },
      request: new Request('https://example.test/api/admin/merchants/merchant/pro-activation', {
        method: 'POST', body: JSON.stringify({ action: 'activate', subscriptionType: 'MONTHLY', dossierValidated: true }),
      }) } as any);
    expect(response.status).toBe(201);
    expect((await response.json()).checkoutUrl).toContain('/api/merchant/pro-renewal-links/');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO konektag.merchant_pro_subscriptions'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO konektag.merchant_pro_renewal_intents'))).toBe(true);
  });

  it('denies a field team account before creating a link', async () => {
    mocks.access.mockResolvedValue({ authorized: true, user: { role: 'field' } });
    const response = await POST({ locals: { user: { id: 'field-user' } }, params: { id: 'merchant' },
      request: new Request('https://example.test/', { method: 'POST', body: '{}' }) } as any);
    expect(response.status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('creates the first subscription only for an approved paid intent', async () => {
    const client = { query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM konektag.merchant_pro_renewal_intents')) return { rows: [{
        id: 'intent', subscription_id: null, subscription_type: 'ANNUAL', price_minor: 101460,
        currency: 'EUR', status: 'PENDING', merchant_profile_id: 'merchant', initial_approved_by: 'central-admin',
      }] };
      if (sql.includes('FROM konektag.api_payment_orders')) return { rows: [{
        state: 'paid', amount_unit: 'MINOR', currency: 'EUR', total_amount: 101460,
        business_purpose: 'pro_subscription_renewal',
      }] };
      if (sql.includes('FROM konektag.merchant_profiles')) return { rows: [{ id: 'merchant' }] };
      if (sql.includes('FROM konektag.merchant_pro_subscriptions')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    }) };
    const service = new MerchantProSubscriptionService({ query: vi.fn() } as any);
    expect(await service.applyPaidRenewal('order', client as any)).toBe(true);
    const insertion = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO konektag.merchant_pro_subscriptions'));
    expect(insertion).toBeDefined();
    expect(insertion![1]).toEqual(expect.arrayContaining(['merchant', 'ANNUAL', 101460, 'EUR', 'central-admin', 'order']));
  });

  it('does not create a subscription for an unpaid order', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM konektag.merchant_pro_renewal_intents')) return { rows: [{
        id: 'intent', subscription_id: null, subscription_type: 'MONTHLY', price_minor: 8900,
        currency: 'EUR', status: 'PENDING', merchant_profile_id: 'merchant', initial_approved_by: 'central-admin',
      }] };
      if (sql.includes('FROM konektag.api_payment_orders')) return { rows: [{
        state: 'pending', amount_unit: 'MINOR', currency: 'EUR', total_amount: 8900,
        business_purpose: 'pro_subscription_renewal',
      }] };
      throw new Error('Unexpected query');
    }) };
    const service = new MerchantProSubscriptionService({ query: vi.fn() } as any);
    await expect(service.applyPaidRenewal('order', client as any)).rejects.toThrow('RENEWAL_PAYMENT_NOT_CONFIRMED');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO konektag.merchant_pro_subscriptions'))).toBe(false);
  });

  it('does not create the first subscription twice on webhook replay', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ id: 'intent', status: 'APPLIED' }] })) };
    const service = new MerchantProSubscriptionService({ query: vi.fn() } as any);
    expect(await service.applyPaidRenewal('order', client as any)).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
