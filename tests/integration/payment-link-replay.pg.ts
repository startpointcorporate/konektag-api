// Replay keys of merchant-profile payment links on a real PostgreSQL (migrations up to 230).
// Text keys (ERP erp-link:…, BOOST-LINK-…) live in checkout_intents.replay_key, unique per merchant;
// core_transaction_id stays a UUID (catalogue). Never production.
import crypto from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== '/konektag_test') throw new Error('DATABASE_URL must point at a throwaway database named konektag_test');

let pool: any, paymentLinkService: any, erp: any;
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

async function merchant() {
  const owner = crypto.randomUUID();
  await pool.query(`INSERT INTO konektag.users (id, keycloak_id, username, email_hash, encrypted_data, state)
    VALUES ($1, $2, $3, $4, '\\x00', 'COMPLETED')`, [owner, crypto.randomUUID(), 'm' + owner.slice(0, 8), sha(owner)]);
  const { rows: [mp] } = await pool.query(`INSERT INTO konektag.merchant_profiles
      (business_name, slug, country, city, user_id, kyb_status)
    VALUES ('Le Jardin', 'jardin-' || gen_random_uuid(), 'CG', 'Brazzaville', $1, 'MERCHANT_APPROVED') RETURNING id`, [owner]);
  return { id: mp.id as string, owner };
}
const erpCreate = (m: { id: string; owner: string }, key: string, amount: string, reference = 'ACC-SINV-1') => erp({
  locals: { user: { id: m.owner } },
  request: new Request('http://x/api/pay/payment-links', { method: 'POST', headers: { 'X-Idempotency-Key': key },
    body: JSON.stringify({ merchantProfileId: m.id, amount, currency: 'XAF', reference }) }),
} as any);
const row = async (slug: string) => (await pool.query(
  'SELECT core_transaction_id, replay_key FROM konektag.checkout_intents WHERE public_id = $1', [slug])).rows[0];
const count = async (merchantId: string) => Number((await pool.query(
  `SELECT count(*) n FROM konektag.checkout_intents WHERE merchant_profile_id = $1`, [merchantId])).rows[0].n);
const hex = () => crypto.randomBytes(32).toString('hex');

beforeAll(async () => {
  pool = (await import('../../src/infrastructure/database/pool.ts')).default;
  ({ paymentLinkService } = await import('../../src/application/services/payment-link-service.ts'));
  ({ POST: erp } = await import('../../src/api/routes/pay/payment-links.ts'));
  await pool.query(`INSERT INTO konektag.exchange_rates (from_currency, to_currency, rate, points_k_status, valid_from, valid_to,
      points_k_matrix_version, points_k_approval_source)
    SELECT 'XAF', 'EUR', 0.0015243902439024, 'APPROVED', '2026-01-01', '2027-12-31', 7, 'TEST'
    WHERE NOT EXISTS (SELECT 1 FROM konektag.exchange_rates WHERE from_currency='XAF' AND points_k_status='APPROVED')`);
});
afterAll(async () => { await pool?.end(); });

describe('payment link replay keys on PostgreSQL', () => {
  it('ERP (erp-link:…): creates, replays the same link, refuses the key with other data', async () => {
    const m = await merchant();
    const key = hex();
    const first = await erpCreate(m, key, '6500');
    expect(first.status).toBe(201);
    const { link } = await first.json();
    expect(await row(link.name)).toEqual({ core_transaction_id: null, replay_key: `erp-link:${m.id}:${key}` });
    const replay = await erpCreate(m, key, '6500');
    expect([replay.status, (await replay.json()).link.name]).toEqual([201, link.name]);
    for (const [amount, reference] of [['7000', 'ACC-SINV-1'], ['6500', 'ACC-SINV-2']]) {
      const other = await erpCreate(m, key, amount, reference);
      expect([other.status, await other.json()]).toEqual([409, { error: 'IDEMPOTENCY_KEY_REUSED' }]);
    }
    expect(await count(m.id)).toBe(1);
    // Without a key, each call is a new link, as before.
    const plain = await erp({ locals: { user: { id: m.owner } }, request: new Request('http://x', { method: 'POST',
      body: JSON.stringify({ merchantProfileId: m.id, amount: '1000', currency: 'XAF' }) }) } as any);
    expect(plain.status).toBe(201);
    expect(await row((await plain.json()).link.name)).toEqual({ core_transaction_id: null, replay_key: null });
  });

  it('BOOST (BOOST-LINK-…): the boost call creates, replays the same link, refuses other data', async () => {
    const m = await merchant();
    const boost = crypto.randomUUID();
    // Exactly the arguments of merchant-social-boost-service (action create-payment-link).
    const call = (budget: number) => paymentLinkService.create({ merchantProfileId: m.id, amountMinor: budget, currency: 'XAF',
      description: 'Boost social Konektag', reference: 'BOOST:' + boost, idempotencyKey: 'BOOST-LINK-' + boost,
      expiration: new Date(Date.now() + 7 * 86400000) });
    const link = await call(25000);
    expect(await row(link.name)).toEqual({ core_transaction_id: null, replay_key: 'BOOST-LINK-' + boost });
    expect((await call(25000)).name).toBe(link.name);
    await expect(call(30000)).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    expect(await count(m.id)).toBe(1);
  });

  it('a replay key is scoped to its merchant', async () => {
    const [a, b] = [await merchant(), await merchant()];
    const args = (id: string) => ({ merchantProfileId: id, amountMinor: 1000, currency: 'XAF', reference: 'R',
      idempotencyKey: 'BOOST-LINK-shared', expiration: new Date(Date.now() + 86400000) });
    const [la, lb] = [await paymentLinkService.create(args(a.id)), await paymentLinkService.create(args(b.id))];
    expect(la.name).not.toBe(lb.name);
    expect((await paymentLinkService.create(args(a.id))).name).toBe(la.name);
    // The database itself refuses a second row with the same key for the same merchant.
    await expect(pool.query(`INSERT INTO konektag.checkout_intents (token_hash, merchant_profile_id, amount, currency, expiration,
      source_type, public_id, replay_key) VALUES ($1, $2, 1, 'XAF', now(), 'payment_link', $3, 'BOOST-LINK-shared')`,
      [hex(), a.id, hex().slice(0, 16)])).rejects.toMatchObject({ constraint: 'checkout_intents_payment_link_replay_key' });
  });

  it('catalogue keeps its UUID in core_transaction_id and replays the same link', async () => {
    const m = await merchant();
    const transactionId = crypto.randomUUID();
    const call = () => paymentLinkService.create({ merchantProfileId: m.id, amountMinor: 4500, currency: 'XAF',
      description: 'Catalogue Konektag', reference: transactionId, expiration: new Date(Date.now() + 30 * 60000), catalog: { transactionId } });
    const link = await call();
    expect(await row(link.name)).toEqual({ core_transaction_id: transactionId, replay_key: null });
    expect((await call()).name).toBe(link.name);
    expect(await count(m.id)).toBe(1);
  });
});
