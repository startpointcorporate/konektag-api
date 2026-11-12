// Points K pawaPay v2 direct deposit against real PostgreSQL: real checkout lock, real attempt rows,
// retries, concurrency, provider rejection and failure compensation. The pawaPay client is an
// injected stub: no sandbox or live pawaPay call, no payment, no ERPNext site.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointsKValuationModule } from '../helpers/points-k-valuation-stub.ts';
import { enableIsolatedPawaPaySandbox } from '../helpers/pawapay-sandbox-runtime.ts';
beforeEach(enableIsolatedPawaPaySandbox);
afterEach(() => vi.unstubAllEnvs());

vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({ redisAdapter: { publishPaymentStatus: async () => {} } }));
vi.mock('../../src/application/services/points-k-valuation-service.ts', () => pointsKValuationModule);

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== '/konektag_test') throw new Error('Use a throwaway konektag_test database');
const { default: pool } = await import('../../src/infrastructure/database/pool.ts');
const { apiPaymentCheckoutService } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');
const { createPointsKCheckout } = await import('../../src/application/services/pay/points-k-checkout-service.ts');
const { startPawaPayDirectDeposit } = await import('../../src/application/services/pay/pawapay-direct-deposit-service.ts');
const { PawaPayError } = await import('../../src/infrastructure/adapters/pawapay-client.ts');

const PHONE_A = '242053456789';
const PHONE_B = '242053456780';
const mtn = { provider: 'MTN_MOMO_COG', nameDisplayedToCustomer: 'MTN MoMo', currency: 'XAF', status: 'OPERATIONAL',
  minAmount: '100', maxAmount: '2000000', decimalsInAmount: 'NONE', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC', pinPromptRevivable: false };

let userId: string;
beforeAll(async () => {
  userId = randomUUID();
  await pool.query(`INSERT INTO konektag.users (id,keycloak_id,username,email_hash,encrypted_data)
    VALUES ($1,$2,$3,$4,'\\x00')`, [userId, randomUUID(), `kon75-${userId.slice(0,8)}`, userId.replaceAll('-', '').padEnd(64, '0')]);
});
afterAll(async () => {
  // Completed financial entries are immutable. Destroy the throwaway database
  // after this suite instead of deleting their acquisition/ledger evidence.
  await pool.end();
});

function nativeDocuments(suffix: string) {
  const quotation = { name: `Q-${suffix}`, docstatus: 0, quotation_to: 'Lead', party_name: 'LEAD', currency: 'XAF',
    disable_rounded_total: 1, grand_total: 8567, items: [{ item_code: 'POINTS-K', qty: 4 }] };
  return {
    get: async (type: string) => type === 'Customer' ? { name: 'CUST', alias: 'kc', lead_name: 'LEAD' } : quotation,
    list: async (type: string) => type === 'Customer' ? [{ name: 'CUST' }]
      : type === 'Mode of Payment' ? [{ name: 'Mobile Money', enabled: 1 }] : [],
    insert: async (_: string, doc: any) => ({ ...doc, name: `SO-${suffix}` }),
    call: async (method: string, args: any) => {
      if (method.endsWith('make_sales_order')) return { customer: 'CUST', company: 'COMPANY', order_type: 'Sales',
        transaction_date: '2026-11-12', currency: 'XAF', items: [{ prevdoc_docname: quotation.name }] };
      if (method.endsWith('make_payment_request')) return { name: `PR-${suffix}`, docstatus: 1,
        reference_doctype: 'Sales Order', reference_name: `SO-${suffix}`, party: 'CUST', currency: 'XAF', grand_total: 8567 };
      return { ...args.doc, docstatus: 1 };
    },
  } as any;
}

/** A frozen Congo Mobile Money Points K checkout, funding prepared for pawaPay. */
async function congoCheckout() {
  const suffix = randomUUID();
  const result = await createPointsKCheckout({ keycloakId: 'kc', userId, country: 'CG', customer: 'CUST',
    quotation: `Q-${suffix}`, modeOfPayment: 'Mobile Money' }, {
    route: async () => ({ residenceCountry: 'CG', paymentCountry: 'CG', slug: 'konektag-cg', site: 'CG', timezone: 'UTC' }),
    site: () => nativeDocuments(suffix),
  });
  const { rows: [ids] } = await pool.query(`SELECT id AS profile_id, legal_entity_id,
    regulated_actor_id, corridor_id FROM konektag.regulatory_profiles LIMIT 1`);
  await apiPaymentCheckoutService.prepareFundingOrder(result.checkoutToken!, { userId } as any, {
    currency: 'XAF', paymentCountry: 'CG', konektagSite: 'konektag-cg', legalEntityId: ids.legal_entity_id,
    regulatoryProfileId: ids.profile_id, corridorId: ids.corridor_id, regulatedActorId: ids.regulated_actor_id,
    rail: 'mobile_money', provider: 'pawapay', providerConfigurationKey: 'KTG_CG_PAWAPAY_SANDBOX', percentageBps: 300, fixedAmount: 1,
  });
  return { token: result.checkoutToken!, orderId: result.order!.id };
}

/** Stubbed pawaPay v2 with the real idempotency rule: a known depositId answers DUPLICATE_IGNORED. */
function fakePawaPay() {
  const known = new Set<string>();
  return {
    predictProvider: vi.fn(async (phoneNumber: string) => ({ country: 'COG', provider: 'MTN_MOMO_COG', phoneNumber })),
    depositProviders: vi.fn(async () => [mtn]),
    createDeposit: vi.fn(async (input: { depositId: string }) => {
      if (known.has(input.depositId)) return { status: 'DUPLICATE_IGNORED' as const };
      known.add(input.depositId); return { status: 'ACCEPTED' as const };
    }),
    getDeposit: vi.fn(async (depositId: string) => {
      if (!known.has(depositId)) throw new PawaPayError('PawaPay deposit NOT_FOUND');
      return { depositId, status: 'ACCEPTED' } as any;
    }),
  } as any;
}

const payer = () => ({ userId } as any);
const start = (token: string, phoneNumber: string, client: any, extra: Record<string, unknown> = {}) =>
  startPawaPayDirectDeposit(token, payer(), { phoneNumber }, { client, ...extra } as any);
async function attempts(orderId: string) {
  const { rows } = await pool.query(`SELECT provider_reference, state, expires_at, metadata, expected_amount
    FROM konektag.payment_provider_attempts WHERE source_type='api_payment' AND source_id=$1 ORDER BY created_at`, [orderId]);
  return rows;
}
async function orderState(orderId: string) {
  const { rows: [row] } = await pool.query('SELECT state, payment_method FROM konektag.api_payment_orders WHERE id=$1', [orderId]);
  return row;
}

describe('Points K pawaPay direct deposit through real PostgreSQL', () => {
  it('refuses a sandbox PSP on a live business order before creating an attempt', async () => {
    const { token, orderId } = await congoCheckout();
    vi.stubEnv('PAWAPAY_ALLOW_SANDBOX', undefined);
    const client = fakePawaPay();
    await expect(start(token, PHONE_A, client)).rejects.toMatchObject({ code: 'PAWAPAY_SANDBOX_DISABLED' });
    expect(await attempts(orderId)).toEqual([]);
    expect(client.createDeposit).not.toHaveBeenCalled();
    expect(client.predictProvider).not.toHaveBeenCalled();
    expect(await orderState(orderId)).toMatchObject({ state: 'pending' });
  });

  it('rejects sandbox callbacks and low-level consumption before any financial event write', async () => {
    const { token, orderId } = await congoCheckout();
    const first = await start(token, PHONE_A, fakePawaPay());
    vi.stubEnv('PAWAPAY_ALLOW_SANDBOX', undefined);
    const deposit = { depositId: first.depositId, status: 'COMPLETED' as const, amount: '8567', currency: 'XAF' };
    const { pawaPayDepositService } = await import('../../src/application/services/pay/pawapay-deposit-service.ts');
    const { paymentProviderAttemptService } = await import('../../src/application/services/pay/payment-provider-attempt-service.ts');
    await expect(pawaPayDepositService.consume(deposit, JSON.stringify(deposit))).rejects.toMatchObject({ code: 'PAWAPAY_SANDBOX_DISABLED' });
    await expect(paymentProviderAttemptService.consumePawaPayDeposit(deposit, 'local-hash')).rejects.toMatchObject({ code: 'PAWAPAY_SANDBOX_DISABLED' });
    await expect(apiPaymentCheckoutService.confirmCheckout(token, 'mobile_money', payer())).rejects.toMatchObject({ code: 'PAWAPAY_SANDBOX_DISABLED' });
    await expect(apiPaymentCheckoutService.markFinalAndDispatch(orderId, 'mobile_money', first.depositId, randomUUID())).rejects.toMatchObject({ code: 'PAWAPAY_SANDBOX_DISABLED' });
    const { rows: [event] } = await pool.query('SELECT count(*)::int n FROM konektag.payment_provider_events WHERE provider_event_id=$1', [`pawapay:deposit:${first.depositId}:COMPLETED`]);
    expect(event.n).toBe(0);
    expect(await attempts(orderId)).toMatchObject([{ state: 'pending' }]);
  });
  it('settles concurrent repeated callbacks once without double credit or duplicate events', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    const first = await start(token, PHONE_A, client);
    const { pawaPayDepositService } = await import('../../src/application/services/pay/pawapay-deposit-service.ts');
    const deposit = { depositId: first.depositId, status: 'COMPLETED' as const, amount: '8567', currency: 'XAF' };
    // Verified-event consumption only; cryptographic verification is covered
    // independently. Provider and valuation are explicit local doubles.
    await Promise.all(Array.from({ length: 4 }, () => pawaPayDepositService.consume(deposit, JSON.stringify(deposit))));
    await pawaPayDepositService.consume(deposit, JSON.stringify(deposit));
    const { rows: [evidence] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM konektag.points_acquisitions WHERE order_id=$1) acquisitions,
      (SELECT count(*)::int FROM konektag.ledger_entries WHERE points_order_id=$1 AND points_leg='allocation_credit') credits,
      (SELECT count(*)::int FROM konektag.payment_provider_events WHERE provider='pawapay' AND provider_event_id=$2) events`,
      [orderId, `pawapay:deposit:${first.depositId}:COMPLETED`]);
    expect(evidence).toEqual({ acquisitions: 1, credits: 1, events: 1 });
    expect(await orderState(orderId)).toMatchObject({ state: 'paid' });
    const { rows: [lot] } = await pool.query('SELECT economic_value FROM konektag.klots WHERE klot_ref=$1', [`KLOT-POINTS-${orderId}`]);
    expect(Number(lot.economic_value)).toBe(8567);
  });
  it('locks the checkout and keeps one observed attempt with the frozen amount', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    await expect(start(token, PHONE_A, client)).resolves.toMatchObject({ outcome: 'awaiting_mobile_money', status: 'ACCEPTED' });
    const rows = await attempts(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'pending', expires_at: null,
      metadata: expect.objectContaining({ depositRequested: true, depositObserved: true }) });
    expect(Number(rows[0].expected_amount)).toBe(8567);
    expect(JSON.stringify(rows[0].metadata)).not.toContain(PHONE_A);
    expect(client.createDeposit.mock.calls[0][0]).toMatchObject({ amount: '8567', currency: 'XAF', depositId: rows[0].provider_reference });
    expect(await orderState(orderId)).toMatchObject({ state: 'awaiting_mobile_money', payment_method: 'mobile_money' });
  });

  it('replays a retry on the same depositId and refuses a second phone', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    const first = await start(token, PHONE_A, client);
    await expect(start(token, PHONE_A, client)).resolves.toMatchObject({ depositId: first.depositId, status: 'DUPLICATE_IGNORED' });
    await expect(start(token, PHONE_B, client)).rejects.toThrow('A payment attempt is still active');
    expect(await attempts(orderId)).toHaveLength(1);
    expect(new Set(client.createDeposit.mock.calls.map((call: any) => call[0].depositId)).size).toBe(1);
  });

  it('creates a single attempt under concurrent starts from the same phone', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => start(token, PHONE_A, client)));
    const ids = new Set(results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<any>).value.depositId));
    expect(ids.size).toBe(1);
    expect(await attempts(orderId)).toHaveLength(1);
    expect(new Set(client.createDeposit.mock.calls.map((call: any) => call[0].depositId))).toEqual(ids);
  });

  it('lets only one of two concurrent phones prompt the payer', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    const results = await Promise.allSettled([start(token, PHONE_A, client), start(token, PHONE_B, client)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await attempts(orderId)).toHaveLength(1);
    expect(client.createDeposit).toHaveBeenCalledTimes(1);
  });

  it('fails a REJECTED deposit, reopens the checkout and allows a new attempt', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    client.createDeposit.mockResolvedValueOnce({ status: 'REJECTED', failureCode: 'INVALID_AMOUNT', failureMessage: 'limit' });
    await expect(start(token, PHONE_A, client)).rejects.toMatchObject({ code: 'PAWAPAY_DEPOSIT_REJECTED', detail: { failureCode: 'INVALID_AMOUNT' } });
    expect(await attempts(orderId)).toMatchObject([{ state: 'failed', metadata: expect.objectContaining({ rejectedFailureCode: 'INVALID_AMOUNT' }) }]);
    expect(await orderState(orderId)).toMatchObject({ state: 'pending' });
    const retry = await start(token, PHONE_B, client);
    const rows = await attempts(orderId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ provider_reference: retry.depositId, state: 'pending' });
    expect(retry.depositId).not.toBe(rows[0].provider_reference);
  });

  it('fails an HTTP 4xx refusal and reopens the checkout', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    client.createDeposit.mockRejectedValueOnce(new PawaPayError('PawaPay request failed (400)', 400, 'INVALID_PHONE_NUMBER'));
    await expect(start(token, PHONE_A, client)).rejects.toMatchObject({ code: 'PAWAPAY_DEPOSIT_REJECTED' });
    expect(await attempts(orderId)).toMatchObject([{ state: 'failed' }]);
    expect(await orderState(orderId)).toMatchObject({ state: 'pending' });
  });

  it('releases the attempt when the checkout lock fails, so another phone is not blocked', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    const failingLock = { ...apiPaymentCheckoutService,
      confirmCheckout: async () => { throw new Error('injected lock failure'); } } as typeof apiPaymentCheckoutService;
    await expect(start(token, PHONE_A, client, { checkout: failingLock })).rejects.toThrow('injected lock failure');
    expect(client.createDeposit).not.toHaveBeenCalled();
    expect(await attempts(orderId)).toMatchObject([{ state: 'cancelled' }]);
    expect(await orderState(orderId)).toMatchObject({ state: 'pending' });
    await expect(start(token, PHONE_B, client)).resolves.toMatchObject({ outcome: 'awaiting_mobile_money' });
  });

  it('reopens an order left awaiting Mobile Money when the lock commits and then fails', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    const lateFailure = { ...apiPaymentCheckoutService, confirmCheckout: async (...args: Parameters<typeof apiPaymentCheckoutService.confirmCheckout>) => {
      await apiPaymentCheckoutService.confirmCheckout(...args); throw new Error('injected failure after commit');
    } } as typeof apiPaymentCheckoutService;
    await expect(start(token, PHONE_A, client, { checkout: lateFailure })).rejects.toThrow('injected failure after commit');
    expect(await attempts(orderId)).toMatchObject([{ state: 'cancelled' }]);
    expect(await orderState(orderId)).toMatchObject({ state: 'pending' });
  });

  it('keeps an ambiguous deposit active and replays it on the same depositId', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    client.createDeposit.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(start(token, PHONE_A, client)).rejects.toMatchObject({ code: 'PAWAPAY_DEPOSIT_UNCONFIRMED', status: 502 });
    const [ambiguous] = await attempts(orderId);
    expect(ambiguous).toMatchObject({ state: 'pending', metadata: expect.objectContaining({ depositRequested: true }) });
    expect(ambiguous.expires_at).not.toBeNull();
    // A lock failure on another request must not release an attempt whose deposit may exist.
    const failingLock = { ...apiPaymentCheckoutService, confirmCheckout: async () => { throw new Error('injected'); } } as typeof apiPaymentCheckoutService;
    await expect(start(token, PHONE_A, client, { checkout: failingLock })).rejects.toThrow('injected');
    expect(await attempts(orderId)).toMatchObject([{ state: 'pending' }]);
    await expect(start(token, PHONE_B, client)).rejects.toThrow('A payment attempt is still active');
    await expect(start(token, PHONE_A, client)).resolves.toMatchObject({ depositId: ambiguous.provider_reference, status: 'ACCEPTED' });
    expect(await attempts(orderId)).toMatchObject([{ state: 'pending', expires_at: null }]);
  });

  it('confirms an ambiguous deposit that the read-only lookup finds at pawaPay', async () => {
    const { token, orderId } = await congoCheckout();
    const client = fakePawaPay();
    const real = client.createDeposit.getMockImplementation();
    client.createDeposit.mockImplementationOnce(async (input: any) => { await real(input); throw new TypeError('socket hang up'); });
    await expect(start(token, PHONE_A, client)).resolves.toMatchObject({ outcome: 'awaiting_mobile_money', status: 'ACCEPTED' });
    expect(await attempts(orderId)).toMatchObject([{ state: 'pending', expires_at: null,
      metadata: expect.objectContaining({ depositObserved: true }) }]);
  });
});
