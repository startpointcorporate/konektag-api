import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, type RequestContext, type RouteHandler } from '../../src/api/http';
import { OnboardingError } from '../../src/domain/DomainErrors.ts';

const m = vi.hoisted(() => ({
  query: vi.fn(), setOtp: vi.fn(), verifyOtp: vi.fn(), checkOtpVerification: vi.fn(), consumeOtpVerification: vi.fn(),
  sendTemplate: vi.fn(), register: vi.fn(), active: vi.fn(), assertSelected: vi.fn(), getUser: vi.fn(), decrypt: vi.fn(), updateUserProfile: vi.fn(),
}));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({ redisAdapter: m }));
vi.mock('../../src/application/services/resend-service.ts', () => ({ emailService: m }));
vi.mock('../../src/application/services/onboarding-service.ts', () => ({ onboardingService: m }));
vi.mock('../../src/application/services/legal-document-service.ts', () => ({ legalDocumentService: m, LegalDocumentsUnavailableError: class extends Error {} }));
vi.mock('../../src/infrastructure/adapters/keycloak-adapter.ts', () => ({ keycloakAdapter: m }));
vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({ encryptionService: m }));
vi.mock('../../src/application/services/auth-service.ts', () => ({ authService: m }));
import { GET as username } from '../../src/api/routes/onboarding/check-username';
import { POST as send } from '../../src/api/routes/onboarding/send-otp';
import { POST as verify } from '../../src/api/routes/onboarding/verify-otp';
import { POST as register } from '../../src/api/routes/onboarding/register';
import { GET as legal } from '../../src/api/routes/legal-documents';
import { GET as me, PUT as updateMe } from '../../src/api/routes/auth/me';

function ctx(path: string, body?: unknown, headers: Record<string, string> = {}): RequestContext {
  return createContext(new Request(`https://api.invalid${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
const documents = ['terms', 'privacy'].map(type => ({ id: type, type, country: 'FR', version: '1', content: 'Approved legal text',
  url: `https://example.invalid/${type}`, hash: 'a'.repeat(64) }));
const input = { firstName: 'Ada', lastName: 'Test', username: 'ada.test', email: 'ada@example.invalid', password: 'test-only-password',
  locale: 'fr', acceptedTerms: true, legalCountry: 'fr', legalDocuments: documents };
const registrationContext = (body: unknown = input) => ctx('/api/onboarding/register', body, { 'X-Idempotency-Key': 'test-registration' });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden in REST tests'); }));
  m.query.mockResolvedValue({ rows: [] }); m.setOtp.mockResolvedValue('123456'); m.sendTemplate.mockResolvedValue(true);
  m.verifyOtp.mockResolvedValue(true); m.checkOtpVerification.mockResolvedValue(true); m.active.mockResolvedValue(documents);
  m.register.mockResolvedValue({ user: { id: 'user-1', username: input.username, state: 'OTP_VERIFIED' }, accessToken: 'access-test', refreshToken: 'refresh-test' });
});

describe('onboarding username', () => {
  it.each(['', 'ab'])('rejects short username %s without reading users', async value => {
    expect(await (await username(ctx(`/api/onboarding/check-username?username=${value}`))).json()).toEqual({ available: false, reason: 'too_short' });
    expect(m.query).not.toHaveBeenCalled();
  });
  it.each([true, false])('reports availability %s using normalized, active user lookup', async available => {
    m.query.mockResolvedValue({ rows: available ? [] : [{ exists: 1 }] });
    expect(await (await username(ctx('/api/onboarding/check-username?username=ADA'))).json()).toEqual({ available });
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'), ['ada']);
  });
});
describe('onboarding OTP', () => {
  it('sends the generated OTP to the normalized recipient with locale fallback', async () => {
    const response = await send(ctx('/api/onboarding/send-otp', { email: 'Ada@Example.invalid', firstName: 'Ada', locale: 'es' }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ message: 'Email de confirmation envoyé' });
    expect(m.setOtp).toHaveBeenCalledWith('Ada@Example.invalid');
    expect(m.sendTemplate).toHaveBeenCalledWith('otpCode', 'fr', 'ada@example.invalid', expect.objectContaining({ firstName: 'Ada', code: '123456' }));
  });
  it('characterizes issue #7: a false Resend result still produces a success response', async () => {
    m.sendTemplate.mockResolvedValue(false);
    const response = await send(ctx('/api/onboarding/send-otp', { email: input.email }));
    expect(m.sendTemplate).toHaveBeenCalled(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Email de confirmation envoyé' });
    // Known defect, deliberately characterized. Proposal in docs/rest-test-audit.md; no business change here.
  });
  it('returns a sanitized error when Resend throws', async () => {
    m.sendTemplate.mockRejectedValue(new Error('private provider key'));
    const response = await send(ctx('/api/onboarding/send-otp', { email: input.email }));
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'SERVER_ERROR' });
  });
  it('does not send when the OTP store is unavailable', async () => {
    m.setOtp.mockRejectedValue(new Error('offline'));
    const response = await send(ctx('/api/onboarding/send-otp', { email: input.email }));
    expect(await response.json()).toEqual({ error: 'SERVER_ERROR' }); expect(m.sendTemplate).not.toHaveBeenCalled();
  });
  for (const [name, handler, path] of [['send', send, '/api/onboarding/send-otp'], ['verify', verify, '/api/onboarding/verify-otp']] as const) {
    it(`${name} rejects malformed JSON without calling providers`, async () => {
      const c = ctx(path, {}); c.request = new Request(c.url, { method: 'POST', body: '{' });
      const response = await handler(c); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'Invalid JSON' });
      expect(m.setOtp).not.toHaveBeenCalled(); expect(m.verifyOtp).not.toHaveBeenCalled();
    });
    it(`${name} rejects invalid fields without calling providers`, async () => {
      const response = await handler(ctx(path, { email: 'invalid', code: '12', locale: 'xx' }));
      expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ errors: { email: expect.any(Array) } });
      expect(m.setOtp).not.toHaveBeenCalled(); expect(m.verifyOtp).not.toHaveBeenCalled();
    });
  }
  it('verifies precisely the submitted email and OTP', async () => {
    expect(await (await verify(ctx('/api/onboarding/verify-otp', { email: input.email, code: '123456' }))).json()).toEqual({ message: 'OTP verified' });
    expect(m.verifyOtp).toHaveBeenCalledWith(input.email, '123456');
  });
  it.each(['INVALID_OTP', 'OTP_EXPIRED', 'OTP_TOO_MANY_ATTEMPTS'])('preserves %s as a business error', async code => {
    if (code === 'INVALID_OTP') m.verifyOtp.mockResolvedValue(false); else m.verifyOtp.mockRejectedValue(new OnboardingError(code));
    const response = await verify(ctx('/api/onboarding/verify-otp', { email: input.email, code: '000000' }));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: code, message: expect.any(String) });
    expect(m.register).not.toHaveBeenCalled();
  });
});
describe('onboarding legal evidence and registration', () => {
  it('returns country-specific legal evidence without caching it', async () => {
    const response = await legal(ctx('/api/legal-documents?country=fr&locale=fr'));
    expect(await response.json()).toEqual({ documents }); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(m.active).toHaveBeenCalledWith('FR', 'fr');
  });
  it('rejects a missing legal country without loading documents', async () => {
    const response = await legal(ctx('/api/legal-documents'));
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: 'legal_country_required' }); expect(m.active).not.toHaveBeenCalled();
  });
  it('requires idempotency before attempting registration', async () => {
    const response = await register(ctx('/api/onboarding/register', input));
    expect(await response.json()).toEqual({ error: 'X-Idempotency-Key header is required' }); expect(m.register).not.toHaveBeenCalled();
  });
  it.each([
    { acceptedTerms: false }, { password: 'short' }, { username: '!!' }, { legalDocuments: [] }, { legalCountry: '???' },
  ])('rejects invalid registration %j before OTP consumption or account creation', async invalid => {
    const response = await register(registrationContext({ ...input, ...invalid }));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ errors: expect.any(Object), message: expect.any(String) });
    expect(m.register).not.toHaveBeenCalled(); expect(m.consumeOtpVerification).not.toHaveBeenCalled(); expect(m.checkOtpVerification).not.toHaveBeenCalled();
  });
  it('refuses an unverified email without creating an account or consuming verification', async () => {
    m.checkOtpVerification.mockResolvedValue(false); const response = await register(registrationContext());
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'EMAIL_NOT_VERIFIED' });
    expect(m.register).not.toHaveBeenCalled(); expect(m.consumeOtpVerification).not.toHaveBeenCalled();
  });
  it('fails closed when legal evidence cannot be verified', async () => {
    const { LegalDocumentsUnavailableError } = await import('../../src/application/services/legal-document-service');
    m.assertSelected.mockRejectedValue(new LegalDocumentsUnavailableError('offline'));
    const c = registrationContext(); const response = await register(c);
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: 'legal_documents_unavailable' });
    expect(m.register).not.toHaveBeenCalled(); expect(c.cookies.outgoing).toEqual([]); expect(m.consumeOtpVerification).not.toHaveBeenCalled();
  });
  it.each(['IDEMPOTENCY_CONFLICT', 'USERNAME_OR_EMAIL_EXISTS'])('preserves %s without issuing cookies', async code => {
    m.register.mockRejectedValue(new OnboardingError(code)); const c = registrationContext(); const response = await register(c);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: code });
    expect(c.cookies.outgoing).toEqual([]); expect(m.consumeOtpVerification).not.toHaveBeenCalled();
  });
  it('runs the onboarding HTTP handlers in order and preserves the frontend session envelope', async () => {
    expect(await (await username(ctx('/api/onboarding/check-username?username=ada.test'))).json()).toEqual({ available: true });
    await send(ctx('/api/onboarding/send-otp', { email: input.email }));
    await verify(ctx('/api/onboarding/verify-otp', { email: input.email, code: '123456' }));
    await legal(ctx('/api/legal-documents?country=FR&locale=fr'));
    const c = registrationContext(); const response = await register(c);
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ userId: 'user-1', username: 'ada.test', state: 'OTP_VERIFIED' });
    expect(m.assertSelected).toHaveBeenCalledWith('FR', 'fr', documents);
    expect(m.register).toHaveBeenCalledWith({ ...input, legalCountry: 'FR', phone: '' }, 'test-registration');
    expect(m.consumeOtpVerification).toHaveBeenCalledWith(input.email);
    expect(m.assertSelected.mock.invocationCallOrder[0]).toBeLessThan(m.register.mock.invocationCallOrder[0]);
    expect(m.register.mock.invocationCallOrder[0]).toBeLessThan(m.consumeOtpVerification.mock.invocationCallOrder[0]);
    expect(c.cookies.outgoing).toHaveLength(2);
    for (const cookie of c.cookies.outgoing) { expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Lax'); expect(cookie).toContain('Path=/'); }
    expect(c.cookies.outgoing[0]).toContain('konektag_access_token=access-test'); expect(c.cookies.outgoing[0]).toContain('Max-Age=300');
    expect(c.cookies.outgoing[1]).toContain('konektag_refresh_token=refresh-test'); expect(c.cookies.outgoing[1]).toContain('Max-Age=2592000');
    // Session principal is injected as middleware would do; this is handler integration, not a real Keycloak E2E.
    c.locals.user = { id: 'user-1', keycloak_id: 'kc-1' };
    m.query.mockResolvedValue({ rows: [{ username: 'ada.test', email_verified: true, phone_verified: false, locale: 'fr' }] });
    m.getUser.mockResolvedValue({ email: input.email, firstName: 'Ada', lastName: 'Test' });
    const profile = await me(c);
    expect(await profile.json()).toMatchObject({ username: 'ada.test', email: input.email, firstName: 'Ada', emailVerified: true, phoneVerified: false });
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'), ['kc-1']);
  });
});
describe('auth profile', () => {
  it.each([['GET', me], ['PUT', updateMe]] as [string, RouteHandler][])('%s refuses anonymous access before providers', async (_, handler) => {
    expect((await handler(ctx('/api/auth/me', {}))).status).toBe(401);
    expect(m.query).not.toHaveBeenCalled(); expect(m.updateUserProfile).not.toHaveBeenCalled(); expect(m.getUser).not.toHaveBeenCalled();
  });
  it('updates only the authenticated Keycloak principal', async () => {
    const c = ctx('/api/auth/me', { firstName: 'Grace', displayName: null }); c.locals.user = { keycloak_id: 'kc-owner' };
    expect(await (await updateMe(c)).json()).toEqual({ message: 'Profile updated successfully' });
    expect(m.updateUserProfile).toHaveBeenCalledWith('kc-owner', { firstName: 'Grace', displayName: null });
  });
  it.each([{ firstName: 1 }, { phoneNumber: false }])('rejects invalid profile %j without writing', async body => {
    const c = ctx('/api/auth/me', body); c.locals.user = { keycloak_id: 'kc-owner' };
    const response = await updateMe(c); expect(response.status).toBe(400); expect(await response.json()).toHaveProperty('error'); expect(m.updateUserProfile).not.toHaveBeenCalled();
  });
  it('preserves the missing profile error', async () => {
    const c = ctx('/api/auth/me'); c.locals.user = { keycloak_id: 'kc-missing' };
    const response = await me(c); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'User not found' }); expect(m.getUser).not.toHaveBeenCalled();
  });
});
