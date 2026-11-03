import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), query: vi.fn(), validateToken: vi.fn(),
  start: vi.fn(), before: vi.fn(), after: vi.fn(), scope: vi.fn(), connect: vi.fn(), role: 'admin' }));
vi.mock('../../src/application/shared/i18n', () => ({ isSupportedLocale: () => true, defaultLocale: 'fr' }));
vi.mock('../../src/application/services/user-api-key-service', () => ({ userApiKeyService: { authenticate: mocks.authenticate } }));
vi.mock('../../src/application/services/auth-service', () => ({ authService: { validateToken: mocks.validateToken, refreshToken: vi.fn() } }));
vi.mock('../../src/infrastructure/database/pool', () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../../src/application/outbox-dispatcher', () => ({ startOutboxDispatcher: mocks.start }));
vi.mock('../../src/application/merchant-service', () => ({ merchantService: {} }));
vi.mock('../../src/application/services/http-idempotency-service', () => ({
  isFinancialMutation: (method: string, path: string) => method === 'POST' && (path.startsWith('/api/pay/') || path.startsWith('/api/admin/clearing/')),
  HttpIdempotencyService: class { beforeHandler = mocks.before; afterHandler = mocks.after; },
}));
vi.mock('../../src/infrastructure/repositories/http-idempotency-repository', () => ({
  HttpIdempotencyRepository: class { insertOrGetFinancialConflict = mocks.scope; },
}));
import { onRequest } from '../../src/api/middleware/security';
import { GET as merchants } from '../../src/api/routes/admin/merchants/index';

const identity = () => ({ keyId: 'api-key', user: { id: 'owner', keycloak_id: 'kc-owner', username: 'owner', locale: 'fr', role: mocks.role,
  state: 'COMPLETED', country: 'FR', access_status: 'ACTIVE' } });
function context(path = '/api/account', method = 'GET', authorization = 'token ktg_test:test', cookie = false) {
  const url = new URL('https://test.local' + path);
  return { url, request: new Request(url, { method, headers: { Authorization: authorization, 'Idempotency-Key': 'unique-request' } }), locals: {},
    cookies: { get: (name: string) => cookie && name === 'konektag_access_token' ? { value: 'admin-cookie' } : undefined, set: vi.fn(), delete: vi.fn() },
    isPrerendered: false } as any;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'admin'; mocks.authenticate.mockImplementation(async () => identity());
  mocks.start.mockResolvedValue(undefined); mocks.connect.mockResolvedValue({ release: vi.fn() });
  mocks.before.mockResolvedValue({ recordId: 'record' }); mocks.scope.mockResolvedValue({ inserted: { id: 'record' } });
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT role') ? [{ role: mocks.role }]
    : sql.includes('legal_entities') ? [{ id: 'entity', code: 'KTG-FR' }] : [] }));
});
it('authenticates an API-only call without using cookies or Keycloak login', async () => {
  const ctx = context(); const next = vi.fn(async () => Response.json({ owner: ctx.locals.user.id }));
  const response = await onRequest(ctx, next) as Response;
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ owner: 'owner' });
  expect(mocks.validateToken).not.toHaveBeenCalled(); expect(ctx.locals.apiKeyId).toBe('api-key');
});
it('rejects invalid credentials even when an admin cookie is supplied', async () => {
  mocks.authenticate.mockResolvedValue(null); const next = vi.fn();
  expect((await onRequest(context('/api/admin/merchants', 'GET', 'token invalid', true), next) as Response).status).toBe(401);
  expect(next).not.toHaveBeenCalled(); expect(mocks.validateToken).not.toHaveBeenCalled();
});
it('preserves admin route checks and reflects a role change on the next call', async () => {
  const first = context('/api/admin/merchants');
  expect((await onRequest(first, async () => merchants(first)) as Response).status).toBe(200);
  mocks.role = 'user'; const second = context('/api/admin/merchants');
  expect((await onRequest(second, async () => merchants(second)) as Response).status).toBe(403);
});
it('rejects blocked users before invoking a route', async () => {
  const value = identity(); value.user.access_status = 'BLOCKED'; mocks.authenticate.mockResolvedValue(value);
  const next = vi.fn(); expect((await onRequest(context(), next) as Response).status).toBe(403); expect(next).not.toHaveBeenCalled();
});
it('keeps KYC restrictions on API calls, including the financial-idempotency path', async () => {
  const value = identity(); value.user.state = 'KYC_PENDING'; mocks.authenticate.mockResolvedValue(value);
  const next = vi.fn(); const response = await onRequest(context('/api/pay/recharges', 'POST'), next) as Response;
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: 'KYC_REQUIRED' }); expect(next).not.toHaveBeenCalled();
  expect(mocks.before).not.toHaveBeenCalled();
});
it('keeps financial account holds before route execution', async () => {
  mocks.query.mockResolvedValue({ rows: [{ status: 'REVIEW', reference: 'hold' }] });
  const next = vi.fn(); const response = await onRequest(context('/api/k/send', 'POST'), next) as Response;
  expect(response.status).toBe(423); expect(next).not.toHaveBeenCalled();
});
it('binds financial idempotency to the API user and legal entity', async () => {
  const next = vi.fn(async () => new Response('approved'));
  expect((await onRequest(context('/api/admin/clearing/approve', 'POST'), next) as Response).status).toBe(200);
  expect(mocks.scope).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'owner', legalEntityId: 'entity', routeKey: 'CLEARING_APPROVE' }), 'unique-request', expect.any(String));
});
it('returns 503 without falling back to a cookie when API authentication storage is unavailable', async () => {
  mocks.authenticate.mockRejectedValue(new Error('database offline')); const next = vi.fn();
  expect((await onRequest(context('/api/account', 'GET', 'token something', true), next) as Response).status).toBe(503); expect(next).not.toHaveBeenCalled();
});
it('does not accept personal credentials on HTML pages', async () => {
  const next = vi.fn(); expect((await onRequest(context('/fr/dashboard/'), next) as Response).status).toBe(401); expect(next).not.toHaveBeenCalled();
});
