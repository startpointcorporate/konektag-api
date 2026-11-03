import { beforeEach, describe, it, expect, vi } from 'vitest';
const service = vi.hoisted(() => ({ identityBootstrap: vi.fn(), enrollIdentity: vi.fn(), revokeDevice: vi.fn() }));
vi.mock('../../src/application/core02-identity-service.ts', () => service);
import { GET, POST } from '../../src/api/routes/device-identity/index.ts';
const user = '11111111-1111-4111-8111-111111111111', origin = 'https://test.konektag.local';
function context(body?: unknown, headers: Record<string, string> = {}, authenticated = true) { const url = new URL(origin + '/api/device-identity/'); return { url, locals: authenticated ? { user: { id: user } } : {}, request: new Request(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { origin, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }) } as any; }
beforeEach(() => { vi.clearAllMocks(); service.identityBootstrap.mockResolvedValue({ userId: user, certificates: [] }); service.enrollIdentity.mockResolvedValue({ certificate: 'signed' }); service.revokeDevice.mockResolvedValue({ revoked: true }); });
describe('CORE02 identity API authorization and boundaries', () => {
    it('requires authentication on GET and POST', async () => { expect((await GET(context(undefined, {}, false))).status).toBe(401); expect((await POST(context({ action: 'certify', proof: 'a' }, {}, false))).status).toBe(401); expect(service.enrollIdentity).not.toHaveBeenCalled(); });
    it('sets no-store for success and error responses', async () => { expect((await GET(context())).headers.get('cache-control')).toBe('no-store'); expect((await GET(context(undefined, {}, false))).headers.get('cache-control')).toBe('no-store'); });
    it.each(['https://attacker.invalid', 'null', ''])('rejects origin %s', async (value) => { expect((await POST(context({ action: 'certify', proof: 'a' }, { origin: value }))).status).toBe(403); expect(service.enrollIdentity).not.toHaveBeenCalled(); });
    it('rejects wrong content type', async () => { expect((await POST(context({ action: 'certify', proof: 'a' }, { 'content-type': 'text/plain' }))).status).toBe(415); });
    it('binds certification to authenticated user', async () => { expect((await POST(context({ action: 'certify', proof: 'signed-proof' }))).status).toBe(200); expect(service.enrollIdentity).toHaveBeenCalledWith(user, 'signed-proof'); });
    it.each([{ action: 'pay', amount: 12 }, { action: 'certify', proof: 'a', ownerUserId: user }, { action: 'revoke', deviceId: 'bad' }, { action: 'certify', proof: 'a'.repeat(4097) }])('rejects unknown commands, fields and invalid schema', async (body) => { expect((await POST(context(body))).status).toBe(400); expect(service.enrollIdentity).not.toHaveBeenCalled(); });
    it('bounds request body even without content length', async () => { expect((await POST(context({ action: 'certify', proof: 'a'.repeat(7000) }))).status).toBe(413); });
    it('revokes only authenticated owner scope', async () => { await POST(context({ action: 'revoke', deviceId: user })); expect(service.revokeDevice).toHaveBeenCalledWith(user, user, undefined); });
    it('does not expose internal errors or secrets', async () => { service.enrollIdentity.mockRejectedValue(new Error('sensitive server secret')); const response = await POST(context({ action: 'certify', proof: 'a' })); expect(await response.text()).not.toContain('sensitive'); });
    it('reports unavailable signing authority without details', async () => { service.enrollIdentity.mockRejectedValue(new Error('AUTHORITY_UNAVAILABLE')); expect((await POST(context({ action: 'certify', proof: 'a' }))).status).toBe(503); });
    it('rejects invalid certificate lookup key', async () => { const ctx = context(); ctx.url.searchParams.set('keyId', 'invalid'); expect((await GET(ctx)).status).toBe(400); expect(service.identityBootstrap).not.toHaveBeenCalled(); });
});

it.each(['GET', 'POST'])('returns sanitized 500 for %s infrastructure failure', async method => {
    const error = Object.assign(new Error('database password=TEST_SECRET'), { code: 'ECONNREFUSED' });
    service.identityBootstrap.mockRejectedValue(error); service.enrollIdentity.mockRejectedValue(error);
    const response = method === 'GET' ? await GET(context()) : await POST(context({ action: 'certify', proof: 'a' }));
    expect(response.status).toBe(500); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'DEVICE_IDENTITY_UNAVAILABLE' });
});
it.each(['OWNER_MISMATCH', 'PROOF_INVALID', 'Invalid signature', 'KEY_EXPIRED'])('keeps recognized %s rejection at 400', async message => {
    service.enrollIdentity.mockRejectedValue(new Error(message));
    expect((await POST(context({action:'certify',proof:'a'}))).status).toBe(400);
});
it('maps policy and capacity failures to sanitized 503', async()=>{
    for(const message of ['POLICY_INVALID','REVOCATION_CAPACITY']){service.identityBootstrap.mockRejectedValue(new Error(message));const response=await GET(context());expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'DEVICE_IDENTITY_UNAVAILABLE'});}
});
it('keeps malformed request JSON at 400',async()=>{const ctx=context({});ctx.request=new Request(ctx.url,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{'});expect((await POST(ctx)).status).toBe(400);});
