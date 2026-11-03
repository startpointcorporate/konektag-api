import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  txQuery: vi.fn(),
  release: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  markAudit: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { connect: mocks.connect, query: mocks.query },
}));
vi.mock('../../src/infrastructure/adapters/erpnext-adapter.ts', () => ({
  erpnext: { list: mocks.list, create: mocks.create, get: mocks.get, update: mocks.update },
}));
vi.mock('../../src/infrastructure/adapters/mautic-adapter.ts', () => ({
  mauticAdapter: { markAuditRequestedByEmail: mocks.markAudit },
}));

const { POST } = await import('../../src/api/routes/public/digital-audit.ts');

function request(email = 'requester@example.com') {
  return {
    request: new Request('https://konektag.eu/api/public/digital-audit', {
      method: 'POST',
      headers: { Origin: 'https://konektag.eu', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business: 'Entreprise Test',
        country: 'France',
        city: 'Paris',
        sector: 'Services',
        email,
        locale: 'fr',
      }),
    }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({
    query: mocks.txQuery,
    release: mocks.release,
  });
  mocks.txQuery.mockImplementation(async (query: string) => {
    if (query.includes('INSERT INTO konektag.outbox_events')) {
      return { rows: [{ id: '123e4567-e89b-12d3-a456-426614174000' }] };
    }
    return { rows: [] };
  });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.list.mockResolvedValue([]);
  mocks.create.mockImplementation(async (doctype: string, doc: any) =>
    doctype === 'Digital Audit'
      ? { name: 'AUDIT-TEST-1', request_id: doc.request_id }
      : { name: 'CONTACT-NEW-1' }
  );
  mocks.get.mockImplementation(async (_doctype: string, name: string) => ({ name, custom_funnel_stage: 'NEW', custom_funnel_result: 'PENDING' }));
  mocks.update.mockResolvedValue({ custom_funnel_stage: 'COMPLETED', custom_funnel_result: 'INTERESTED' });
  mocks.markAudit.mockResolvedValue('tagged');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('A03 public digital audit → Mautic', () => {
  it('accepts canonical public Origin behind an internal reverse proxy URL', async () => {
    const ctx = request();
    ctx.request = new Request('http://konektag-api:3000/api/public/digital-audit', {
      method: 'POST',
      headers: { Origin: 'https://www.konektag.eu', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business: 'Entreprise Test', country: 'France', city: 'Paris',
        sector: 'Services', email: 'requester@example.com', locale: 'fr'
      })
    });
    const response = await POST(ctx);
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls.map(c => c[0])).not.toContain('Lead');
  });

  it('rejects an untrusted Origin before any CRM write', async () => {
    const ctx = request();
    ctx.request = new Request('https://www.konektag.eu/api/public/digital-audit', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business: 'Entreprise Test', country: 'France', city: 'Paris',
        sector: 'Services', email: 'requester@example.com', locale: 'fr'
      })
    });
    const response = await POST(ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'FORBIDDEN_ORIGIN' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.markAudit).not.toHaveBeenCalled();
  });

  it.each(['NEW', 'IN_PROGRESS', 'COMPLETED'])(
    'blocks an existing %s audit without CRM writes or Mautic tagging',
    async status => {
      mocks.list.mockImplementation(async (doctype: string) =>
        doctype === 'Digital Audit' ? [{ name: 'AUDIT-1', status }] : []
      );
      const response = await POST(request());
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'AUDIT_ALREADY_EXISTS' });
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.markAudit).not.toHaveBeenCalled();
      expect(mocks.txQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    }
  );

  it('allows a new audit when all previous audits are CANCELLED', async () => {
    mocks.list.mockImplementation(async (doctype: string) =>
      doctype === 'Digital Audit'
        ? [{ name: 'AUDIT-1', status: 'CANCELLED' }, { name: 'AUDIT-2', status: 'CANCELLED' }]
        : doctype === 'Contact' ? [{ name: 'CONTACT-1' }] : []
    );
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls.map(c => c[0])).toEqual(['Digital Audit']);
  });

  it('blocks if one of multiple audits is not CANCELLED', async () => {
    mocks.list.mockImplementation(async (doctype: string) =>
      doctype === 'Digital Audit'
        ? [{ name: 'AUDIT-1', status: 'CANCELLED' }, { name: 'AUDIT-2', status: 'NEW' }]
        : []
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('accepts an organic request absent from Mautic without creating a Mautic Contact', async () => {
    mocks.markAudit.mockResolvedValue('not_found');
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: 'received' });
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls.map(c => c[0])).toEqual(['Contact', 'Digital Audit']);
    expect(mocks.markAudit).toHaveBeenCalledExactlyOnceWith('requester@example.com');
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SET processed_at = now()'),
      ['123e4567-e89b-12d3-a456-426614174000'],
    );
    expect(mocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO konektag.outbox_events'),
      expect.arrayContaining([expect.stringContaining('requester@example.com')]),
    );
  });

  it('records and tags a request from an existing ERPNext Contact without a new Lead', async () => {
    mocks.list.mockImplementation(async (type: string) =>
      type === 'Contact' ? [{ name: 'CONTACT-1' }] : []
    );
    const response = await POST(request(' EXISTING@example.com '));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: 'received' });
    expect(mocks.create.mock.calls.map(c => c[0])).toEqual(['Digital Audit']);
    expect(mocks.markAudit).toHaveBeenCalledExactlyOnceWith('existing@example.com');
    expect(mocks.txQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO konektag.outbox_events'),
      expect.any(Array),
    );
  });

  it('reuses the Contact without creating a Lead', async () => {
    mocks.list.mockImplementation(async (type: string) =>
      type === 'Contact' ? [{ name: 'CONTACT-1' }] : []
    );
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls.map(c => c[0])).toEqual(['Digital Audit']);
    expect(mocks.markAudit).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls.map(c => c[0])).not.toContain('Lead');
  });

  it('refuses ambiguous Contacts without creating an audit or tagging Mautic', async () => {
    mocks.list.mockImplementation(async (doctype: string) =>
      doctype === 'Contact' ? [{ name: 'CONTACT-1' }, { name: 'CONTACT-2' }] : []
    );
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.markAudit).not.toHaveBeenCalled();
  });

  it('does not create a duplicate Contact when an existing Lead is found', async () => {
    mocks.list.mockImplementation(async (type: string) =>
      type === 'Lead' ? [{ name: 'LEAD-1' }] : []
    );
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.markAudit).not.toHaveBeenCalled();
  });

  it('accepts a committed audit if Mautic is temporarily unavailable and leaves an outbox retry', async () => {
    mocks.markAudit.mockRejectedValue(new Error('MAUTIC_AUDIT_DELIVERY_FAILED'));
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: 'received' });
    expect(mocks.txQuery.mock.calls.some(([sql]) => String(sql) === 'COMMIT')).toBe(true);
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('SET processed_at = now()'), expect.any(Array)
    );
  });

  it('returns an error and does not tag when the request could not be stored', async () => {
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO konektag.outbox_events')) throw new Error('Database unavailable');
      return { rows: [] };
    });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.markAudit).not.toHaveBeenCalled();
    expect(mocks.txQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });
});
