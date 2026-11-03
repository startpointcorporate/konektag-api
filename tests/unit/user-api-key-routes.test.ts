import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), revoke: vi.fn() }));
vi.mock('../../src/application/services/user-api-key-service.ts', () => ({ userApiKeyService: mocks }));
import { GET, POST } from '../../src/api/routes/account/api-keys/index.ts';
import { DELETE } from '../../src/api/routes/account/api-keys/[id].ts';

const keyId = '11111111-1111-4111-8111-111111111111';
function context(method = 'GET', body?: unknown, origin = 'https://test.local') {
  return { request: new Request('https://test.local/api/account/api-keys', { method,
    headers: { 'Content-Type': 'application/json', Origin: origin },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    locals: { user: { id: 'owner', access_status: 'ACTIVE' } }, params: { id: keyId } } as any;
}
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.create.mockResolvedValue({ api_key: 'key', api_secret: 'one-time-secret' }); });
it('returns credentials once at creation with no-store headers', async () => {
  const response = await POST(context('POST', { label: ' Contracts ' })) as Response;
  expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toHaveProperty('api_secret', 'one-time-secret');
  expect(mocks.create).toHaveBeenCalledWith('owner', 'Contracts', null);
});
it('lists only the signed-in user metadata', async () => {
  const response = await GET(context()) as Response; expect(response.status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith('owner'); expect(await response.json()).toEqual({ keys: [] });
});
it.each([{}, { label: '' }, { label: 'Contracts', user_id: 'admin' }, { label: 'Contracts', expires_at: '2020-01-01T00:00:00Z' }])('rejects invalid or owner-injection requests', async body => {
  expect((await POST(context('POST', body)) as Response).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
});
it('rejects cross-origin creation', async () => {
  expect((await POST(context('POST', { label: 'Stolen' }, 'https://attacker.test')) as Response).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
});
it('requires a browser session for key management', async () => {
  const ctx = context('POST', { label: 'New key' }); ctx.locals.apiKeyId = 'current-api-key';
  expect((await POST(ctx) as Response).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
});
it('rejects unauthenticated or blocked users', async () => {
  const ctx = context(); ctx.locals = {}; expect((await GET(ctx) as Response).status).toBe(401);
  ctx.locals = { user: { id: 'owner', access_status: 'BLOCKED' } }; expect((await GET(ctx) as Response).status).toBe(403);
});
it('does not revoke another user key', async () => {
  mocks.revoke.mockResolvedValue(false); const response = await DELETE(context('DELETE')) as Response;
  expect(response.status).toBe(404); expect(mocks.revoke).toHaveBeenCalledWith('owner', keyId);
});
it('allows the owner to revoke a key', async () => {
  mocks.revoke.mockResolvedValue(true); expect((await DELETE(context('DELETE')) as Response).status).toBe(200);
});

it('creates and revokes behind the HTTPS reverse proxy using the target Host', async () => {
  const ctx = context('POST', { label: 'Contracts' });
  ctx.request = new Request('http://127.0.0.1:4321/api/account/api-keys', {
    method: 'POST', headers: { Host: 'www.konektag.eu', Origin: 'https://www.konektag.eu', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Contracts' }),
  });
  expect((await POST(ctx) as Response).status).toBe(201);
  mocks.revoke.mockResolvedValue(true);
  ctx.request = new Request('http://127.0.0.1:4321/api/account/api-keys/' + keyId, {
    method: 'DELETE', headers: { Host: 'www.konektag.eu', Origin: 'https://www.konektag.eu' },
  });
  expect((await DELETE(ctx) as Response).status).toBe(200);
});
it.each(['https://attacker.test', 'https://www.konektag.eu:8443', 'null', 'https://www.konektag.eu/path', ''])('rejects unsafe origins behind the proxy: %s', async origin => {
  const ctx = context('POST', { label: 'Contracts' });
  ctx.request = new Request('http://127.0.0.1:4321/api/account/api-keys', {
    method: 'POST', headers: { Host: 'www.konektag.eu', Origin: origin, 'X-Forwarded-Host': 'attacker.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Contracts' }),
  });
  expect((await POST(ctx) as Response).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
});
