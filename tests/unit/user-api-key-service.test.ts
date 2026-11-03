import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ query: vi.fn(), decrypt: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({ encryptionService: { decrypt: mocks.decrypt } }));
import { parseUserApiAuthorization, userApiKeyService } from '../../src/application/services/user-api-key-service.ts';

const key = 'ktg_' + 'a'.repeat(32);
const secret = 'b'.repeat(64);
const hash = createHash('sha256').update(key + ':' + secret).digest('hex');
beforeEach(() => { vi.clearAllMocks(); mocks.decrypt.mockReturnValue('{"email":"owner@example.test"}'); });

describe('personal API credentials', () => {
  it('creates independent random credentials and stores only their bound hash', async () => {
    mocks.query.mockImplementation(async (_sql, args) => ({ rows: [{ id: 'key-id', api_key: args[2], label: args[1] }] }));
    const first = await userApiKeyService.create('owner', 'CRM');
    const second = await userApiKeyService.create('owner', 'ERP');
    expect(first.api_key).not.toBe(second.api_key);
    expect(first.api_secret).not.toBe(second.api_secret);
    const args = mocks.query.mock.calls[0][1];
    expect(args).not.toContain(first.api_secret);
    expect(args[3]).toBe(createHash('sha256').update(first.api_key + ':' + first.api_secret).digest('hex'));
    expect(first).not.toHaveProperty('secret_hash');
  });
  it('lists metadata scoped to the owner without selecting secrets or hashes', async () => {
    mocks.query.mockResolvedValue({ rows: [] }); await userApiKeyService.list('owner');
    expect(mocks.query.mock.calls[0][0]).not.toContain('secret_hash');
    expect(mocks.query.mock.calls[0][1]).toEqual(['owner']);
  });
  it('authenticates the current user and removes secret/internal fields from the identity', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ key_id: 'key-id', secret_hash: hash,
      id: 'owner', keycloak_id: 'kc-owner', role: 'user', state: 'COMPLETED', encrypted_data: Buffer.from('encrypted') }] });
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const identity = await userApiKeyService.authenticate(`token ${key}:${secret}`);
    expect(identity).toEqual({ keyId: 'key-id', user: { id: 'owner', keycloak_id: 'kc-owner', role: 'user', state: 'COMPLETED', email: 'owner@example.test' } });
    expect(mocks.query.mock.calls[0][0]).toContain('u.deleted_at IS NULL');
    expect(mocks.query.mock.calls[0][0]).toContain('k.revoked_at IS NULL');
    expect(mocks.query.mock.calls[0][0]).toContain('k.expires_at > now()');
  });
  it('rejects a wrong secret without decrypting user data or updating last use', async () => {
    mocks.query.mockResolvedValue({ rows: [{ secret_hash: hash }] });
    expect(await userApiKeyService.authenticate(`token ${key}:${'c'.repeat(64)}`)).toBeNull();
    expect(mocks.decrypt).not.toHaveBeenCalled(); expect(mocks.query).toHaveBeenCalledOnce();
  });
  it('rejects revoked, expired or deleted-user keys absent from the active join', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await userApiKeyService.authenticate(`token ${key}:${secret}`)).toBeNull();
  });
  it.each([null, '', `Bearer ${key}`, `token ${key}`, `token ${key}:${secret}:extra`, 'token short:short'])('rejects malformed credentials before querying: %s', async header => {
    expect(parseUserApiAuthorization(header)).toBeNull();
    expect(await userApiKeyService.authenticate(header)).toBeNull(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('revokes only a key belonging to the signed-in user', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await userApiKeyService.revoke('owner', 'someone-elses-key')).toBe(false);
    expect(mocks.query.mock.calls[0][1]).toEqual(['someone-elses-key', 'owner']);
    expect(mocks.query.mock.calls[0][0]).toContain('user_id = $2');
  });
});
