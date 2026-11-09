import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), activation: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/application/services/merchant-activation-service.ts', () => ({ merchantActivationService: { requireMerchantApproved: mocks.activation } }));
import { GET, POST } from '../../src/api/routes/pay/payment-links.ts';

const merchantProfileId = '11111111-1111-4111-8111-111111111111';
const key = 'a'.repeat(64);
const operationId = '33333333-3333-4333-8333-333333333333';
let stored: any;
const user = { id: 'u1', keycloak_id: 'kc1' };
const post = (fields: Record<string, unknown>, headers: Record<string, string> = {}) => POST({
  request: new Request('http://x', { method: 'POST', headers, body: JSON.stringify({ amount: '6500', currency: 'XAF', reference: 'ACC-SINV-2026-00012', merchantProfileId, ...fields }) }),
  locals: { user },
} as any);

beforeEach(() => {
  vi.resetAllMocks();
  stored = null;
  mocks.activation.mockResolvedValue({ ok: true });
  mocks.query.mockImplementation(async (sql: string, params: any[]) => {
    if (sql.includes('SELECT id, user_id, status')) return { rows: [{ id: merchantProfileId, user_id: 'u1', status: 'Published' }] };
    if (sql.includes('konektag.merchant_memberships mm') && sql.includes('checkout_intents')) return { rows: stored ? [stored] : [] };
    if (sql.includes('konektag.merchant_memberships')) return { rows: [{ present: 1 }] };
    if (sql.includes('SELECT country FROM konektag.merchant_profiles')) return { rows: [{ country: 'CG' }] };
    if (sql.includes('FROM konektag.exchange_rates')) return { rows: [{ id: '22222222-2222-4222-8222-222222222222', rate: '0.0015243902439024', points_k_matrix_version: 7,
      valid_from: '2026-01-01T00:00:00.000Z', valid_to: '2027-01-01T00:00:00.000Z', points_k_approval_source: 'TEST' }] };
    if (sql.includes('INSERT INTO konektag.checkout_intents')) {
      if (stored) return { rows: [] };
      stored = { merchant_profile_id: params[1], quantity_k: params[2], currency: params[3], expiration: params[5], public_id: params[6],
        reference: params[7], amount: params[8], core_transaction_id: params[9], quote_valuation: JSON.parse(params[10]), status: 'ISSUED' };
      return { rows: [stored] };
    }
    if (sql.includes('SELECT * FROM konektag.checkout_intents WHERE core_transaction_id')) return { rows: stored?.core_transaction_id === params[0] ? [stored] : [] };
    if (sql.includes('SELECT business_name')) return { rows: [{ business_name: 'Merchant' }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

describe('Link Pay ERP return contract', () => {
  it('returns the already issued link when an ERP retries with the same key', async () => {
    const first = await (await post({}, { 'X-Idempotency-Key': key })).json();
    const replay = await post({}, { 'X-Idempotency-Key': key });
    expect(replay.status).toBe(201);
    expect((await replay.json()).link.name).toBe(first.link.name);
    expect(stored.core_transaction_id).toBe(`erp-link:${merchantProfileId}:${key}`);
  });

  it('refuses a key reused for another amount or a malformed key', async () => {
    await post({}, { 'X-Idempotency-Key': key });
    expect((await post({ amount: '7000' }, { 'X-Idempotency-Key': key })).status).toBe(409);
    expect((await post({}, { 'X-Idempotency-Key': 'bad' })).status).toBe(400);
  });

  it('keeps links without a key independent', async () => {
    await post({});
    expect(stored.core_transaction_id).toBeNull();
  });

  it('exposes the operation of a consumed link only in the owner listing, filtered by reference', async () => {
    await post({}, { 'X-Idempotency-Key': key });
    Object.assign(stored, { status: 'CONSUMED', k_operation_id: operationId, consumed_at: '2026-11-09T10:00:00.000Z', business_name: 'Merchant' });
    const list = async (query: string) => (await (await GET({ url: new URL('http://x/api/pay/payment-links?' + query), locals: { user } } as any)).json()).links;
    const [link] = await list(`merchantProfileId=${merchantProfileId}&reference=ACC-SINV-2026-00012`);
    expect(link).toMatchObject({ status: 'Used', operationId, paidAt: '2026-11-09T10:00:00.000Z', amount: 6500, currency: 'XAF' });
    expect(await list(`merchantProfileId=${merchantProfileId}&reference=OTHER`)).toEqual([]);
  });
});
