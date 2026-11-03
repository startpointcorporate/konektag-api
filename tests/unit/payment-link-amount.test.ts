import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), activation: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/application/services/merchant-activation-service.ts', () => ({ merchantActivationService: { requireMerchantApproved: mocks.activation } }));
import { POST } from '../../src/api/routes/pay/payment-links.ts';
import { majorToMinor } from '../../src/application/services/pay/money-unit.ts';

const merchantProfileId = '11111111-1111-4111-8111-111111111111';
const authorityId = '22222222-2222-4222-8222-222222222222';
let merchantCountry: string;
let authorityAvailable: boolean;
const call = (amount: unknown, fields: Record<string, unknown> = {}) => POST({
  request: new Request('http://x', { method: 'POST', body: JSON.stringify({ amount, ...fields, merchantProfileId }) }),
  locals: { user: { id: 'u1', keycloak_id: 'kc1' } },
} as any);
const insertCall = () => mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO konektag.checkout_intents'));

// Exercise the real route, membership check, currency conversion and official K valuation.
// Only persistence and the separately tested activation service are fixtures.
beforeEach(() => {
  vi.resetAllMocks();
  merchantCountry = 'CG';
  authorityAvailable = true;
  mocks.activation.mockResolvedValue({ ok: true });
  mocks.query.mockImplementation(async (sql: string, params: any[]) => {
    if (sql.includes('SELECT id, user_id, status')) return { rows: [{ id: merchantProfileId, user_id: 'u1', status: 'Published' }] };
    if (sql.includes('konektag.merchant_memberships')) return { rows: [{ present: 1 }] };
    if (sql.includes('SELECT country FROM konektag.merchant_profiles')) return { rows: [{ country: merchantCountry }] };
    if (sql.includes('FROM konektag.exchange_rates')) return { rows: authorityAvailable ? [{
      id: authorityId, rate: params[0] === 'EUR' ? '1' : '0.0015243902439024', points_k_matrix_version: 7,
      valid_from: '2026-01-01T00:00:00.000Z', valid_to: '2027-01-01T00:00:00.000Z', points_k_approval_source: 'TEST_APPROVAL',
    }] : [] };
    if (sql.includes('INSERT INTO konektag.checkout_intents')) return { rows: [{
      merchant_profile_id: params[1], quantity_k: params[2], currency: params[3], expiration: params[5],
      public_id: params[6], amount: params[8], quote_valuation: JSON.parse(params[10]), status: 'ISSUED',
    }] };
    if (sql.includes('SELECT business_name')) return { rows: [{ business_name: 'Merchant' }] };
    throw new Error(`Unexpected SQL in payment link amount fixture: ${sql}`);
  });
});

async function expectIssued(amount: unknown, currency: string, amountMinor: number, quantityK: number, fields: Record<string, unknown> = {}) {
  merchantCountry = currency === 'EUR' ? 'FR' : 'CG';
  const response = await call(amount, { currency, ...fields });
  expect(response.status).toBe(201);
  const body = await response.json();
  const insert = insertCall()!;
  expect(insert[1][2]).toBe(quantityK);
  expect(insert[1][3]).toBe(currency);
  expect(insert[1][8]).toBe(amountMinor);
  const valuation = JSON.parse(insert[1][10]);
  expect(valuation).toMatchObject({ sourceCurrency: currency, sourceAmountMinor: amountMinor, quantityK, authorityId, matrixVersion: 7, approvalSource: 'TEST_APPROVAL' });
  expect(valuation.proofHash).toMatch(/^[a-f0-9]{64}$/);
  expect(body.link).toMatchObject({ amount: amountMinor, quantityK, currency, valuation, status: 'Active' });
  expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO konektag.checkout_intents'))).toHaveLength(1);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("mm.role IN ('owner', 'manager')"), [merchantProfileId, 'u1']);
}

describe('payment link amount validation', () => {
  it.each([-1, 0, 'bad'])('rejects invalid amount %s before side effects', async amount => {
    const response = await call(amount);
    expect(response.status).toBe(400);
    expect(mocks.activation).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('creates a link for a positive integer amount', async () => {
    await expectIssued(6560, 'XAF', 6560, 10);
  });
  it.each([
    ['10', 'EUR', 1000, 10], [10, 'EUR', 1000, 10], ['10.5', 'EUR', 1050, 11],
    ['1000', 'XAF', 1000, 2], [1000, 'XAF', 1000, 2],
  ])('stores %s %s entered in major units as %i minor units', async (amount, currency, minor, quantityK) => {
    await expectIssued(amount, currency, minor, quantityK);
  });
  it('converts 0.01 EUR to 1 minor unit but rejects a link below the official K minimum', async () => {
    expect(majorToMinor('0.01', 'EUR')).toBe(1);
    merchantCountry = 'FR';
    const response = await call('0.01', { currency: 'EUR' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'POINTS_K_AMOUNT_TOO_SMALL' });
    expect(insertCall()).toBeUndefined();
  });
  it.each([['10.001', 'EUR'], ['10.5', 'XAF']])('rejects %s %s beyond the currency minor precision without creating a link', async (amount, currency) => {
    merchantCountry = currency === 'EUR' ? 'FR' : 'CG';
    const response = await call(amount, { currency });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'AMOUNT_PRECISION_INVALID' });
    expect(insertCall()).toBeUndefined();
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('FROM konektag.exchange_rates'))).toHaveLength(0);
  });
  it('issues an official server valuation without merchant-local evidence', async () => {
    await expectIssued(1000, 'XAF', 1000, 2);
  });
  it('ignores a forged merchant quantity and freezes the official server quantity', async () => {
    await expectIssued(1000, 'XAF', 1000, 2, { amountMinor: 1000, quantityK: 999 });
  });
  it('ignores an unapproved client reference and freezes the approved server authority', async () => {
    await expectIssued(1000, 'XAF', 1000, 2, {
      valuationReference: { authorityId: '33333333-3333-4333-8333-333333333333', matrixVersion: 999, proofHash: 'c'.repeat(64) },
    });
  });
  it('rejects a requested currency different from the merchant country currency', async () => {
    const response = await call(1000, { currency: 'EUR', amountMinor: 1000, quantityK: 10 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'MERCHANT_CURRENCY_MISMATCH' });
    expect(insertCall()).toBeUndefined();
  });
  it('rejects issuance when no approved server valuation rate is available', async () => {
    authorityAvailable = false;
    const response = await call(1000, { currency: 'XAF', quantityK: 999 });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'POINTS_K_RATE_NOT_APPROVED' });
    expect(insertCall()).toBeUndefined();
  });
});
