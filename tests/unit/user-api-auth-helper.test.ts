import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), validateToken: vi.fn(), refreshToken: vi.fn() }));
vi.mock('../../src/application/services/user-api-key-service.ts', () => ({ userApiKeyService: { authenticate: mocks.authenticate } }));
vi.mock('../../src/application/services/auth-service.ts', () => ({ authService: mocks }));
import { getAuthPayload } from '../../src/application/shared/auth-helper.ts';
const cookies = { get: () => ({ value: 'browser-token' }), set: vi.fn() };
const request = () => new Request('https://test.local/api/recharge/stripe/create-intent', { headers: { Authorization: 'token test-key:test-secret' } });
beforeEach(() => { vi.clearAllMocks(); });
it('returns the existing Keycloak subject for personal API credentials', async () => {
  mocks.authenticate.mockResolvedValue({ user: { keycloak_id: 'kc-owner', email: 'owner@example.test', access_status: 'ACTIVE' } });
  expect(await getAuthPayload(request(), cookies, 'https://test.local')).toEqual({ sub: 'kc-owner', email: 'owner@example.test' });
  expect(mocks.validateToken).not.toHaveBeenCalled();
});
it('does not fall back to browser authentication for an invalid API key', async () => {
  mocks.authenticate.mockResolvedValue(null);
  expect(await getAuthPayload(request(), cookies, 'https://test.local')).toBeNull(); expect(mocks.validateToken).not.toHaveBeenCalled();
});
it('refuses a blocked API user', async () => {
  mocks.authenticate.mockResolvedValue({ user: { keycloak_id: 'kc-owner', access_status: 'BLOCKED' } });
  expect(await getAuthPayload(request(), cookies, 'https://test.local')).toBeNull();
});
it('preserves cookie authentication when no personal credentials are sent', async () => {
  mocks.validateToken.mockResolvedValue({ sub: 'browser-owner', email: 'browser@example.test' });
  expect(await getAuthPayload(new Request('https://test.local/api/recharge/stripe/create-intent'), cookies, 'https://test.local'))
    .toEqual({ sub: 'browser-owner', email: 'browser@example.test' });
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
