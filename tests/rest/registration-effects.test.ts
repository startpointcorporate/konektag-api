import { beforeEach, expect, it, vi } from 'vitest';
import { createContext } from '../../src/api/http';
const m = vi.hoisted(() => ({
  createUser: vi.fn(), deleteUser: vi.fn(), directGrant: vi.fn(), encrypt: vi.fn(),
  findByKey: vi.fn(), insertKey: vi.fn(), storeResult: vi.fn(), insertUser: vi.fn(), markEmailVerified: vi.fn(),
  query: vi.fn(), audit: vi.fn(), outbox: vi.fn(), checkOtpVerification: vi.fn(), consumeOtpVerification: vi.fn(), assertSelected: vi.fn(),
}));
vi.mock('../../src/infrastructure/unit-of-work.ts', () => ({ UnitOfWork: class {
  execute(work: (tx: any) => unknown) { return work({
    idempotencyRepo: { findByKey: m.findByKey, insert: m.insertKey, storeResult: m.storeResult },
    userRepo: { insert: m.insertUser, markEmailVerified: m.markEmailVerified }, client: { query: m.query },
    auditRepo: { log: m.audit }, outboxRepo: { insert: m.outbox },
  }); }
} }));
vi.mock('../../src/infrastructure/adapters/keycloak-adapter.ts', () => ({ keycloakAdapter: m }));
vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({ encryptionService: m }));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({ redisAdapter: m }));
vi.mock('../../src/application/services/legal-document-service.ts', () => ({ legalDocumentService: m, LegalDocumentsUnavailableError: class extends Error {} }));
import { POST } from '../../src/api/routes/onboarding/register';
const legalDocuments = ['terms', 'privacy'].map(type => ({ id: type, type, country: 'FR', version: 'approved-1', content: `approved ${type}`,
  hash: 'a'.repeat(64), url: `https://example.invalid/${type}` }));
const input = { firstName: 'Ada', lastName: 'Test', email: 'ada@example.invalid', username: 'ada.test', password: 'local-test-password',
  locale: 'fr', acceptedTerms: true, legalCountry: 'FR', legalDocuments };
function c() { return createContext(new Request('https://api.invalid/api/onboarding/register', {
  method: 'POST', headers: { 'X-Idempotency-Key': 'register-1' }, body: JSON.stringify(input),
})); }
beforeEach(() => {
  vi.resetAllMocks(); m.checkOtpVerification.mockResolvedValue(true); m.findByKey.mockResolvedValue(null);
  m.createUser.mockResolvedValue('kc-1'); m.encrypt.mockReturnValue('test-ciphertext');
  m.insertUser.mockResolvedValue({ id: 'user-1', keycloak_id: 'kc-1', username: input.username, state: 'OTP_VERIFIED', email_hash: 'test-hash' });
  m.directGrant.mockResolvedValue({ accessToken: 'test-access', refreshToken: 'test-refresh' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); }));
});
it('registers through the real application service, writes legal evidence and emits a PII-free event', async () => {
  const response = await POST(c()); expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ userId: 'user-1', username: input.username, state: 'OTP_VERIFIED' });
  expect(m.createUser).toHaveBeenCalledWith(expect.objectContaining({ username: input.username, emailVerified: true, requiredActions: [], attributes: { onboarding_state: 'OTP_VERIFIED' } }));
  expect(m.insertUser).toHaveBeenCalledWith(expect.objectContaining({ keycloakId: 'kc-1', state: 'OTP_VERIFIED' }), 'test-ciphertext');
  expect(m.markEmailVerified).toHaveBeenCalledWith('user-1');
  expect(m.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO konektag.legal_consents'), expect.arrayContaining(['user-1', true, 'FR', 'terms', 'privacy', 'approved terms', 'approved privacy']));
  expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', eventType: 'USER_CREATED' }));
  expect(m.outbox).toHaveBeenCalledWith(expect.objectContaining({ aggregateId: 'user-1', eventType: 'UserRegistered', payload: { userId: 'user-1', keycloakId: 'kc-1', emailHash: 'test-hash', locale: 'fr', legalCountry: 'FR' } }));
  expect(JSON.stringify(m.outbox.mock.calls)).not.toContain(input.email); expect(JSON.stringify(m.audit.mock.calls)).not.toContain(input.password);
  expect(m.storeResult).toHaveBeenCalledWith('register-1', 201, { userId: 'user-1' }); expect(m.directGrant).toHaveBeenCalledWith(input.username, input.password);
  expect(m.consumeOtpVerification).toHaveBeenCalledWith(input.email);
});
it('rejects a duplicate idempotency key before a second Keycloak account or event', async () => {
  m.findByKey.mockResolvedValue({ id: 'already-registered' }); const context = c(); const response = await POST(context);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'IDEMPOTENCY_CONFLICT' });
  expect(m.createUser).not.toHaveBeenCalled(); expect(m.insertUser).not.toHaveBeenCalled(); expect(m.outbox).not.toHaveBeenCalled();
  expect(m.consumeOtpVerification).not.toHaveBeenCalled(); expect(context.cookies.outgoing).toEqual([]);
});
it('compensates the Keycloak account when inserting the local user fails', async () => {
  m.insertUser.mockRejectedValue(new Error('database unavailable')); const context = c(); const response = await POST(context);
  expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'SERVER_ERROR' });
  expect(m.deleteUser).toHaveBeenCalledWith('kc-1'); expect(m.outbox).not.toHaveBeenCalled(); expect(m.directGrant).not.toHaveBeenCalled();
  expect(m.consumeOtpVerification).not.toHaveBeenCalled(); expect(context.cookies.outgoing).toEqual([]);
});
it('does not insert a local user when Keycloak creation fails', async () => {
  m.createUser.mockRejectedValue(new Error('Keycloak offline')); const response = await POST(c());
  expect(await response.json()).toEqual({ error: 'SERVER_ERROR' }); expect(m.insertUser).not.toHaveBeenCalled(); expect(m.outbox).not.toHaveBeenCalled(); expect(m.consumeOtpVerification).not.toHaveBeenCalled();
});
