import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

describe('mauticAdapter OAuth', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses the form-encoded client credentials grant required by Mautic', async () => {
    process.env.MAUTIC_BASE_URL = 'https://mautic.test';
    process.env.MAUTIC_OAUTH_CLIENT_ID = 'client-id';
    process.env.MAUTIC_OAUTH_CLIENT_SECRET = 'client-secret';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts: {} })));

    const { mauticAdapter } = await import('../../src/infrastructure/adapters/mautic-adapter.ts');
    await mauticAdapter.findByKonektagUserId('user-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mautic.test/oauth/v2/token');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect((init?.body as URLSearchParams).toString()).toBe('grant_type=client_credentials&client_id=client-id&client_secret=client-secret');
  });
});

describe('A03 Digital Audit — unique contact tagging', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function setup(contacts: Record<string, unknown>, total: number) {
    process.env.MAUTIC_BASE_URL = 'https://mautic.test';
    process.env.MAUTIC_OAUTH_CLIENT_ID = 'client-id';
    process.env.MAUTIC_OAUTH_CLIENT_SECRET = 'client-secret';
    return vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contacts, total }), { status: 200 }));
  }

  it('never creates or blocks when the email has no Mautic Contact', async () => {
    const fetchMock = setup({}, 0);
    const { mauticAdapter } = await import('../../src/infrastructure/adapters/mautic-adapter.ts');
    expect(await mauticAdapter.markAuditRequestedByEmail('  CUSTOMER@EXAMPLE.COM ')).toBe('not_found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('search=%21email%3Acustomer%40example.com');
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET']);
  });

  it('adds audit_requested only to an exactly matching existing Contact', async () => {
    const fetchMock = setup({
      '35': { id: 35, fields: { all: { email: 'alice@example.com' } }, tags: [{ id: 2, tag: 'existing' }] },
    }, 1).mockResolvedValueOnce(new Response(JSON.stringify({ contact: { id: 35 } }), { status: 200 }));

    const { mauticAdapter } = await import('../../src/infrastructure/adapters/mautic-adapter.ts');
    expect(await mauticAdapter.markAuditRequestedByEmail('ALICE@example.com')).toBe('tagged');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe('https://mautic.test/api/contacts/35/edit');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ tags: ['audit_requested'] });
    expect(fetchMock.mock.calls[2][1]?.method).not.toBe('POST');
  });

  it('does not write again if the Contact already has the tag', async () => {
    const fetchMock = setup({
      '35': { id: 35, fields: { all: { email: 'alice@example.com' } }, tags: ['audit_requested', 'existing'] },
    }, 1);
    const { mauticAdapter } = await import('../../src/infrastructure/adapters/mautic-adapter.ts');
    expect(await mauticAdapter.markAuditRequestedByEmail('alice@example.com')).toBe('tagged');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses to tag an ambiguous or incomplete email match', async () => {
    const fetchMock = setup({
      '35': { id: 35, fields: { all: { email: 'same@example.com' } } },
      '36': { id: 36, fields: { all: { email: 'same@example.com' } } },
    }, 2);
    const { mauticAdapter } = await import('../../src/infrastructure/adapters/mautic-adapter.ts');
    await expect(mauticAdapter.markAuditRequestedByEmail('same@example.com')).rejects.toThrow('MAUTIC_AUDIT_EMAIL_AMBIGUOUS');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not tag a fuzzy search result', async () => {
    const fetchMock = setup({
      '35': { id: 35, fields: { all: { email: 'bob@example.com' } } },
    }, 1);
    const { mauticAdapter } = await import('../../src/infrastructure/adapters/mautic-adapter.ts');
    expect(await mauticAdapter.markAuditRequestedByEmail('alice@example.com')).toBe('not_found');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an unavailable Mautic instance as a retryable error', async () => {
    const fetchMock = setup({}, 0);
    fetchMock.mockReset().mockRejectedValue(new Error('secret network details'));
    const { mauticAdapter } = await import('../../src/infrastructure/adapters/mautic-adapter.ts');
    await expect(mauticAdapter.markAuditRequestedByEmail('alice@example.com')).rejects.toThrow('MAUTIC_AUDIT_DELIVERY_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
