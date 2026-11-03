import { beforeEach, expect, it, vi } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: db }));
vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({ encryptionService: {
  decrypt: () => JSON.stringify({ firstName: 'Alice', lastName: 'Test', email: 'owner@example.test', phone: '+242TEST' }),
} }));
import { GET } from '../../src/api/routes/admin/merchants/[id]/kyb/contract.ts';
import { buildMerchantContract } from '../../src/application/shared/contract/merchant-contract-document.ts';
const id = '11111111-1111-4111-8111-111111111111';
const merchant = { id, user_id: 'owner-id', business_name: 'Étoile & Fils <Test>',
  city: 'Brazzaville', country: 'Congo', address: '12 avenue Test', email: 'test@example.test',
  kyb_settlement_rail: 'mobile_money', kyb_settlement_account: 'TEST-ACCOUNT' };
function entries(zip: Buffer) {
  const files: Record<string, string> = {}; let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18), n = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + n).toString();
    const start = offset + 30 + n + extra;
    files[name] = inflateRawSync(zip.subarray(start, start + size)).toString(); offset = start + size;
  }
  return files;
}
beforeEach(() => { db.query.mockReset(); });
const ctx = () => ({ locals: { user: { id: 'admin' } }, params: { id } } as any);
it('preserves the contract articles, escapes stored values and leaves missing fields to complete', () => {
  const zip = buildMerchantContract(merchant), files = entries(zip), xml = files['word/document.xml'];
  expect(files['[Content_Types].xml']).toContain('wordprocessingml');
  expect(xml).toContain('Étoile &amp; Fils &lt;Test&gt;'); expect(xml).toContain('TEST-ACCOUNT');
  expect(xml).toContain('Règlement hebdomadaire : chaque lundi.');
  expect(xml).toContain('____________________'); expect(xml).not.toMatch(/\[\[|\{\{|\{%/);
  expect(xml.replace(/<[^>]+>/g, '')).toContain('[ ] Gratuite [ ] Payante');
  if (process.env.CONTRACT_QA_OUTPUT) writeFileSync(process.env.CONTRACT_QA_OUTPUT, zip);
});
it('rejects unauthenticated and non-admin access before reading a dossier', async () => {
  const anonymous = ctx(); anonymous.locals = {};
  expect((await GET(anonymous) as Response).status).toBe(401); expect(db.query).not.toHaveBeenCalled();
  db.query.mockResolvedValueOnce({ rows: [{ role: 'user' }] });
  expect((await GET(ctx()) as Response).status).toBe(403); expect(db.query).toHaveBeenCalledTimes(1);
});
it('rejects a missing merchant or deleted owner', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }).mockResolvedValueOnce({ rows: [] });
  expect((await GET(ctx()) as Response).status).toBe(404);
});
it('downloads an editable contract without changing signed reference or KYB gates', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] }).mockResolvedValueOnce({ rows: [{ ...merchant }] })
    .mockResolvedValue({ rows: [] });
  const r = await GET(ctx()) as Response;
  expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
  expect(r.headers.get('content-disposition')).toContain('.docx');
  expect(entries(Buffer.from(await r.arrayBuffer()))['word/document.xml']).toContain('owner-id');
  for (const [sql] of db.query.mock.calls) expect(sql.trim()).toMatch(/^SELECT/);
});
it('rejects malformed merchant ids and reports generation errors without private data', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] });
  const invalid = ctx(); invalid.params.id = 'bad'; expect((await GET(invalid) as Response).status).toBe(400);
  db.query.mockRejectedValueOnce(new Error('private details'));
  expect(await (await GET(ctx()) as Response).json()).toEqual({ error: 'CONTRACT_GENERATION_FAILED' });
});
it('prefills the owner contact from the encrypted account without exposing encrypted data', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
    .mockResolvedValueOnce({ rows: [{ ...merchant, email: null, owner_encrypted_data: Buffer.from('encrypted-private') }] })
    .mockResolvedValue({ rows: [] });
  const response = await GET(ctx()) as Response;
  expect(response.status).toBe(200);
  const xml = entries(Buffer.from(await response.arrayBuffer()))['word/document.xml'];
  expect(xml).toContain('Alice Test'); expect(xml).toContain('owner@example.test');
  expect(xml).not.toContain('encrypted-private');
});

it('generates a contract without querying any activity profiles', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
    .mockResolvedValueOnce({ rows: [{ ...merchant }] });
  const response = await GET(ctx()) as Response;
  expect(response.status).toBe(200);
  expect(db.query).toHaveBeenCalledTimes(2);
  const xml = entries(Buffer.from(await response.arrayBuffer()))['word/document.xml'];
  expect(xml).toContain('Étoile &amp; Fils');
});
it('reports unexpected merchant query errors without exposing private details', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }] })
      .mockRejectedValueOnce(new Error('database unavailable'));
    const response = await GET(ctx()) as Response;
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'CONTRACT_GENERATION_FAILED' });
    expect(spy).toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
