import { beforeEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ decide: vi.fn(), apiDecide: vi.fn(), profile: vi.fn(), create: vi.fn(), revoke: vi.fn(), info: vi.fn(), update: vi.fn(), rotate: vi.fn(), list: vi.fn(), activation: vi.fn(), query: vi.fn(), validate: vi.fn(), order: vi.fn(), save: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/application/services/entitlement-decision-service.ts', async importOriginal => {
  const original = await importOriginal<any>();
  return { ...original, entitlementDecisionService: { decide: m.decide, decideForApiPrincipal: m.apiDecide } };
});
vi.mock('../../src/application/services/analytics-access.ts', () => ({ resolveAnalyticsAccess: vi.fn().mockResolvedValue({ profileId: 'shop' }) }));
vi.mock('../../src/application/merchant-service.ts', () => ({ merchantService: { getProfile: m.profile, saveProducts: m.save } }));
vi.mock('../../src/application/services/merchant-api-key-service.ts', () => ({ merchantApiKeyService: { createKey: m.create, revokeKey: m.revoke, getKeyInfo: m.info, validateApiKey: m.validate } }));
vi.mock('../../src/application/services/merchant-activation-service.ts', () => ({ merchantActivationService: { requireMerchantApproved: m.activation } }));
vi.mock('../../src/application/services/pay/api-payment-webhook-service.ts', () => ({ apiPaymentWebhookService: { updateEndpoint: m.update, rotateSecret: m.rotate, listEndpoints: m.list }, ApiPaymentWebhookValidationError: class extends Error {} }));
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({ apiPaymentCheckoutService: { createOrder: m.order }, ApiPaymentValidationError: class extends Error {} }));
vi.mock('../../src/application/services/operation-currency-service.ts', () => ({ resolveMerchantOperationCurrency: vi.fn().mockResolvedValue({ currency: 'EUR' }) }));
import { POST as createKey, DELETE as revokeKey } from '../../src/api/routes/merchant/api-key.ts';
import { PUT as webhook, POST as rotateWebhook } from '../../src/api/routes/merchant/api-webhook.ts';
import { POST as pay } from '../../src/api/routes/pay/payments.ts';
import { GET as exportCsv } from '../../src/api/routes/merchant/analytics/export.ts';

function context(body: unknown = {}, user: unknown = { id: 'actor' }) {
  return { locals: { user }, request: new Request('http://localhost/api', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer key' }, body: JSON.stringify(body) }) } as any;
}
const denied = { allowed: false, reasonCode: 'SUBSCRIPTION_INACTIVE', actorId: 'actor', merchantId: 'shop', capability: 'integration.api', subscriptionState: 'ABSENT', correlationId: 'test' };
beforeEach(() => {
  vi.clearAllMocks(); m.profile.mockResolvedValue({ id: 'shop' }); m.activation.mockResolvedValue({ ok: true });
  m.decide.mockResolvedValue(denied); m.apiDecide.mockResolvedValue(denied); m.validate.mockResolvedValue({ merchantProfileId: 'shop', environment: 'live' });
  m.create.mockResolvedValue({ publicKey: 'new' }); m.update.mockResolvedValue({}); m.rotate.mockResolvedValue({}); m.query.mockResolvedValue({ rows: [] });
});
describe('direct Pro route guards', () => {
  it.each([createKey, revokeKey, webhook, rotateWebhook])('requires identity', async route => {
    expect((await route(context({}, null))).status).toBe(401); expect(m.decide).not.toHaveBeenCalled();
  });
  it.each(['ABSENT','SCHEDULED','EXPIRED','INACTIVE'])('refuses new keys for %s before mutation', async subscriptionState => {
    m.decide.mockResolvedValue({ ...denied, subscriptionState });
    expect((await createKey(context({ environment: 'live' }))).status).toBe(403);
    expect(m.create).not.toHaveBeenCalled();
  });
  it('creates with server-approved Pro capability', async () => {
    m.decide.mockResolvedValue({ ...denied, allowed: true, reasonCode: 'ALLOWED', subscriptionState: 'ACTIVE' });
    expect((await createKey(context({ environment: 'live' }))).status).toBe(201);
    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actor', merchantId: 'shop', capability: 'integration.api' }));
    expect(m.create).toHaveBeenCalledOnce();
  });
  it('revokes expired keys using a free security capability', async () => {
    m.decide.mockResolvedValue({ ...denied, allowed: true, subscriptionState: 'EXPIRED' });
    expect((await revokeKey(context({ environment: 'live' }))).status).toBe(204);
    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({ capability: 'integration.revoke' }));
    expect(m.revoke).toHaveBeenCalledOnce();
  });
  it('refuses configuration and rotation before webhook mutation', async () => {
    expect((await webhook(context({ environment: 'live', url: 'https://example.com/hook' }))).status).toBe(403);
    expect((await rotateWebhook(context({ environment: 'live', action: 'rotate-secret' }))).status).toBe(403);
    expect(m.update).not.toHaveBeenCalled(); expect(m.rotate).not.toHaveBeenCalled();
  });
  it('permits webhook deactivation after expiry', async () => {
    m.decide.mockResolvedValue({ ...denied, allowed: true, subscriptionState: 'EXPIRED' });
    expect((await webhook(context({ environment: 'live', url: ' ' }))).status).toBe(200);
    expect(m.decide).toHaveBeenCalledWith(expect.objectContaining({ capability: 'integration.revoke' }));
  });
  it('denies use of an old valid API key without Pro before creating an order', async () => {
    expect((await pay(context({}))).status).toBe(403); expect(m.order).not.toHaveBeenCalled();
    expect(m.apiDecide).toHaveBeenCalledWith('shop');
  });
  it('denies export before querying analytics', async () => {
    const ctx = context(); ctx.request = new Request('http://localhost/api/export');
    expect((await exportCsv(ctx)).status).toBe(403); expect(m.query).not.toHaveBeenCalled();
  });
  it('propagates a backend failure without creating a key', async () => {
    m.decide.mockRejectedValue(new Error('DB failure'));
    expect((await createKey(context({ environment: 'live' }))).status).toBe(500); expect(m.create).not.toHaveBeenCalled();
  });
});
