import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), decide: vi.fn() }));
vi.mock('../../src/application/pro-inquiry-service.ts', () => ({ proInquiryService: { create: mocks.create } }));
vi.mock('../../src/application/services/entitlement-decision-service.ts', () => ({
  entitlementDecisionService: { decide: mocks.decide },
  entitlementResponse: () => Response.json({ error: 'DENIED' }, { status: 403 }),
}));
vi.mock('../../src/application/services/backoffice-permission-service.ts', () => ({
  requireBackofficePermission: vi.fn(), forbiddenResponse: vi.fn(),
}));

import { POST } from '../../src/api/routes/pro/inquiries/index.ts';

const merchantProfileId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const request = () => new Request('https://konektag.test/api/pro/inquiries/', { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ businessName: 'Commerce', email: 'merchant@example.test', merchantProfileId }),
});

describe('linked Pro inquiry', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.create.mockResolvedValue({ id: 'inquiry-1' }); });

  it('rejects an untrusted commerce id without an authenticated merchant', async () => {
    expect((await POST({ request: request(), locals: {} } as any)).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a commerce outside the actor membership', async () => {
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await POST({ request: request(), locals: { user: { id: 'other' } } } as any)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('links a verified merchant request to its commerce', async () => {
    mocks.decide.mockResolvedValue({ allowed: true });
    expect((await POST({ request: request(), locals: { user: { id: 'owner' } } } as any)).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ merchantProfileId }));
  });
});
