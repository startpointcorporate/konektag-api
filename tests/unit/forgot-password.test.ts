import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));

const mockDecrypt = vi.fn();
vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({
  encryptionService: { decrypt: mockDecrypt },
}));

const mockSendTemplate = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/application/services/resend-service.ts', () => ({
  emailService: { sendTemplate: mockSendTemplate },
}));

vi.mock('../../src/infrastructure/adapters/keycloak-adapter.ts', () => ({
  keycloakAdapter: { resetPassword: vi.fn() },
}));

let forgotHandler: any;
let resetHandler: any;

beforeEach(async () => {
  vi.resetAllMocks();
  mockSendTemplate.mockResolvedValue(undefined);
  const forgotMod = await import('../../src/api/routes/auth/forgot-password.ts');
  forgotHandler = forgotMod.POST;
  const resetMod = await import('../../src/api/routes/auth/reset-password.ts');
  resetHandler = resetMod.POST;
});

function mockReq(body: any) {
  return { request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) };
}

describe('POST /api/auth/forgot-password', () => {
  it('rejects empty email', async () => {
    const res = await forgotHandler(mockReq({ email: '' }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid email format', async () => {
    const res = await forgotHandler(mockReq({ email: 'notanemail' }));
    expect(res.status).toBe(400);
  });

  it('returns success even if email not found (no disclosure)', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    const res = await forgotHandler(mockReq({ email: 'unknown@test.com' }));
    expect(res.status).toBe(200);
    const data = JSON.parse(await res.text());
    expect(data.success).toBe(true);
  });

  it('generates token and sends email for existing user', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 'u-1', keycloak_id: 'kc-1', encrypted_data: 'enc', locale: 'fr' }] })
      .mockResolvedValueOnce({ rows: [] });

    mockDecrypt.mockReturnValue(JSON.stringify({ email: 'user@test.com', firstName: 'Jean' }));

    const res = await forgotHandler(mockReq({ email: 'user@test.com' }));
    expect(res.status).toBe(200);

    // Token was inserted
    const insertCall = mockPool.query.mock.calls.find((c: any) =>
      String(c[0]).includes('INSERT INTO konektag.password_reset_tokens')
    );
    expect(insertCall).toBeTruthy();

    // Email was sent
    expect(mockSendTemplate).toHaveBeenCalled();
    const emailUrl = mockSendTemplate.mock.calls[0][3].resetUrl;
    expect(emailUrl).toContain('/fr/auth/reset-password?token=');
  });
});

describe('POST /api/auth/reset-password', () => {
  it('rejects missing token', async () => {
    const res = await resetHandler(mockReq({ password: 'NewPass123!' }));
    expect(res.status).toBe(400);
  });

  it('rejects short password', async () => {
    const res = await resetHandler(mockReq({ token: 'abc', password: 'short' }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid token', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    const res = await resetHandler(mockReq({ token: 'invalid', password: 'NewPass123!' }));
    expect(res.status).toBe(400);
    const data = JSON.parse(await res.text());
    expect(data.error).toBe('TOKEN_INVALID');
  });

  it('rejects expired token', async () => {
    const past = new Date(Date.now() - 3600000).toISOString();
    mockPool.query.mockResolvedValue({ rows: [{ id: 't-1', keycloak_id: 'kc-1', expires_at: past, used_at: null }] });
    const res = await resetHandler(mockReq({ token: 'abc', password: 'NewPass123!' }));
    expect(res.status).toBe(400);
    expect((JSON.parse(await res.text())).error).toBe('TOKEN_EXPIRED');
  });

  it('rejects already used token', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: 't-1', keycloak_id: 'kc-1', expires_at: '2099-01-01', used_at: '2026-01-01' }] });
    const res = await resetHandler(mockReq({ token: 'abc', password: 'NewPass123!' }));
    expect(res.status).toBe(400);
    expect((JSON.parse(await res.text())).error).toBe('TOKEN_ALREADY_USED');
  });

  it('resets password and marks token used', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 't-1', keycloak_id: 'kc-1', expires_at: future, used_at: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const { keycloakAdapter } = await import('../../src/infrastructure/adapters/keycloak-adapter.ts');

    const res = await resetHandler(mockReq({ token: 'valid-token', password: 'NewPass123!' }));
    expect(res.status).toBe(200);

    expect(keycloakAdapter.resetPassword).toHaveBeenCalledWith('kc-1', 'NewPass123!');

    const updateCall = mockPool.query.mock.calls.find((c: any) => String(c[0]).includes('UPDATE'));
    expect(updateCall).toBeTruthy();
  });
});
