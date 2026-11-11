import { beforeEach, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/api/router';
const m = vi.hoisted(() => ({ query: vi.fn(), validateToken: vi.fn(), refreshToken: vi.fn(), authenticate: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool', () => ({ default: { query: m.query } }));
vi.mock('../../src/application/services/auth-service', () => ({ authService: m }));
vi.mock('../../src/application/services/user-api-key-service', () => ({ userApiKeyService: { authenticate: m.authenticate } }));
vi.mock('../../src/application/services/merchant-api-key-service', () => ({ merchantApiKeyService: {} }));
vi.mock('../../src/infrastructure/adapters/keycloak-adapter', () => ({ keycloakAdapter: m }));
vi.mock('../../src/infrastructure/adapters/encryption-service', () => ({ encryptionService: { decrypt: vi.fn() } }));
import { onRequest } from '../../src/api/middleware/security';

const profile = { id: 'user-1', keycloak_id: 'kc-owner', username: 'ada.test', locale: 'fr', state: 'COMPLETED', role: 'user', access_status: 'ACTIVE' };
const post = (cookie = '', body: unknown = {}) => dispatch(new Request('https://api.invalid/api/points-k/quotations', {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
}), '127.0.0.1', onRequest);

beforeEach(() => {
  vi.resetAllMocks();
  m.query.mockResolvedValue({ rows: [profile] });
  m.validateToken.mockResolvedValue({ sub: 'kc-owner', email: 'ada@example.invalid' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); }));
});

it('is a protected route: anonymous callers are refused before the handler or ERPNext', async () => {
  const response = await post();
  expect(response.status).toBe(401);
  // The middleware's code, not the handler's 'Unauthorized': the path is not public.
  expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
  expect(fetch).not.toHaveBeenCalled();
});

it('reaches the handler with a Keycloak session, without the financial idempotency key', async () => {
  const response = await post('konektag_access_token=valid-access', { country: 'FR' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'INVALID_REQUEST' });
  expect(m.validateToken).toHaveBeenCalledWith('valid-access');
  expect(fetch).not.toHaveBeenCalled();
});
