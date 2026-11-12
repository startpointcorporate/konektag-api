// Real order insertion and funding reads; native ERPNext documents are explicit local fixtures.
// No payment provider, webhook, live ERPNext site or network credentials are used.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Capture the real Stripe route's outgoing SDK arguments; never contact Stripe.
const stripeCalls = vi.hoisted(() => ({ create: vi.fn(async (input: any) => ({
  ...input, id: 'pi_kon74_local', client_secret: 'kon74-local-stub',
})) }));
vi.mock('stripe', () => ({ default: class { paymentIntents = { create: stripeCalls.create }; } }));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({ redisAdapter: { publishPaymentStatus: async () => {} } }));
vi.mock('../../src/application/services/pay/payment-provider-attempt-service.ts', () => ({ paymentProviderAttemptService: {
  expireStaleApiPaymentAttempts: async () => {}, hasActiveApiPaymentAttempt: async () => false,
  createOrUpdateStripeApiCheckoutAttempt: async () => {}, recordRechargeAccepted: async () => {},
} }));

const url = process.env.DATABASE_URL;
if (!url || new URL(url).pathname !== '/konektag_test') throw new Error('Use a throwaway konektag_test database');
const { default: pool } = await import('../../src/infrastructure/database/pool.ts');
const { apiPaymentCheckoutService, toStripeAmount } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');
const { createPointsKCheckout } = await import('../../src/application/services/pay/points-k-checkout-service.ts');
const { toPawaPayAmount } = await import('../../src/infrastructure/adapters/pawapay-client.ts');
const { POST: createStripeIntent } = await import('../../src/api/routes/pay/checkout/[token]/stripe/create-intent.ts');
let userId: string;
beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_kon74_local_stub';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_kon74_local_stub';
  userId = randomUUID();
  await pool.query(`INSERT INTO konektag.users (id,keycloak_id,username,email_hash,encrypted_data)
    VALUES ($1,$2,$3,$4,'\\x00')`, [userId, randomUUID(), `kon74-${userId.slice(0,8)}`, userId.replaceAll('-', '').padEnd(64, '0')]);
});
afterAll(async () => {
  await pool.query('DELETE FROM konektag.api_payment_orders WHERE target_user_id=$1', [userId]);
  await pool.query('DELETE FROM konektag.users WHERE id=$1', [userId]);
  await pool.end();
});

function nativeDocuments(currency: string, grandTotal: number, mode: string, suffix: string) {
  const quotation = { name: `Q-${suffix}`, docstatus: 0, quotation_to: 'Lead', party_name: 'LEAD', currency,
    disable_rounded_total: 1, grand_total: grandTotal, items: [{ item_code: 'POINTS-K', qty: 4 }] };
  return {
    get: async (type: string) => type === 'Customer' ? { name: 'CUST', alias: 'kc', lead_name: 'LEAD' } : quotation,
    list: async (type: string) => type === 'Customer' ? [{ name: 'CUST' }]
      : type === 'Mode of Payment' ? [{ name: mode, enabled: 1 }] : [],
    insert: async (_: string, doc: any) => ({ ...doc, name: `SO-${suffix}` }),
    call: async (method: string, args: any) => {
      if (method.endsWith('make_sales_order')) return { customer: 'CUST', company: 'COMPANY', order_type: 'Sales',
        transaction_date: '2026-11-11', currency, items: [{ prevdoc_docname: quotation.name }] };
      if (method.endsWith('make_payment_request')) return { name: `PR-${suffix}`, docstatus: 1,
        reference_doctype: 'Sales Order', reference_name: `SO-${suffix}`, party: 'CUST', currency, grand_total: grandTotal };
      return { ...args.doc, docstatus: 1 };
    },
  } as any;
}

describe('Points K amount units through real PostgreSQL', () => {
  it('keeps an existing non-ERPNext recharge in whole currency units', async () => {
    const result = await apiPaymentCheckoutService.createWalletRechargeOrder({ targetUserId: userId,
      currency: 'EUR', amount: 12, paymentCountry: 'FR' });
    const { rows: [order] } = await pool.query('SELECT * FROM konektag.api_payment_orders WHERE id=$1', [result.order.id]);
    expect(order.amount_unit).toBe('MAJOR');
    expect(Number(order.total_amount)).toBe(12);
    expect(toStripeAmount(order.currency, Number(order.total_amount), order.amount_unit)).toBe(1200);
  });
  it('opens no PSP order for a native Lebanon Wire Transfer', async () => {
    const suffix = randomUUID();
    const result = await createPointsKCheckout({ keycloakId: 'kc', userId, country: 'LB', customer: 'CUST',
      quotation: `Q-${suffix}`, modeOfPayment: 'Wire Transfer' }, {
      route: async () => ({ residenceCountry: 'LB', paymentCountry: 'LB', slug: 'konektag-lb', site: 'LB', timezone: 'UTC' }),
      site: () => nativeDocuments('USD', 12.21, 'Wire Transfer', suffix),
    });
    expect(result).toMatchObject({ paymentRequest: `PR-${suffix}`, modeOfPayment: 'Wire Transfer', provider: null, order: null, checkoutToken: null });
    const { rows } = await pool.query(`SELECT 1 FROM konektag.api_payment_orders
      WHERE order_metadata #>> '{erpnextPointsK,paymentRequest}'=$1`, [`PR-${suffix}`]);
    expect(rows).toHaveLength(0);
  });
  // USD stays a technical two-decimal assertion on a CB route; Lebanon itself has no CB mode.
  for (const [currency, country, major, minor] of [
    ['EUR', 'FR', 4.8, 480], ['EUR', 'FR', 12, 1200], ['EUR', 'FR', 99.6, 9960],
    ['USD', 'FR', 12.21, 1221], ['XAF', 'CG', 8567, 8567],
  ] as const) {
    it(`${major} ${currency} is stored as ${minor} MINOR and sent to the provider once`, async () => {
      const suffix = randomUUID();
      const mode = country === 'FR' ? 'CB' : 'Mobile Money';
      const result = await createPointsKCheckout({ keycloakId: 'kc', userId, country, customer: 'CUST',
        quotation: `Q-${suffix}`, modeOfPayment: mode }, {
        route: async () => ({ residenceCountry: country, paymentCountry: country, slug: `konektag-${country.toLowerCase()}`, site: country, timezone: 'UTC' }),
        site: () => nativeDocuments(currency, major, mode, suffix),
      });
      const { rows: [order] } = await pool.query('SELECT * FROM konektag.api_payment_orders WHERE id=$1', [result.order!.id]);
      expect(order.amount_unit).toBe('MINOR');
      expect(Number(order.total_amount)).toBe(minor);
      expect(Number(order.external_amount)).toBe(minor);
      expect(result).toMatchObject({ amount: major, amountMinor: minor });
      expect(result.order).toMatchObject({ amountUnit: 'MINOR', totalAmount: minor });
      expect(order.order_metadata.erpnextPointsK).toMatchObject({ quantityK: 4, modeOfPayment: mode,
        provider: country === 'CG' ? 'pawapay' : 'stripe', paymentMethod: country === 'CG' ? 'mobile_money' : 'card' });
      // Exercise the real funding preparation too. The standard migrations include
      // legacy France VAT: it must not tax the native ERPNext TTC a second time.
      const { rows: [ids] } = await pool.query(`SELECT id AS profile_id, legal_entity_id,
        regulated_actor_id, corridor_id FROM konektag.regulatory_profiles LIMIT 1`);
      const prepared = await apiPaymentCheckoutService.prepareFundingOrder(result.checkoutToken!, { userId } as any, {
        currency, paymentCountry: country, konektagSite: `konektag-${country.toLowerCase()}`,
        legalEntityId: ids.legal_entity_id, regulatoryProfileId: ids.profile_id,
        corridorId: ids.corridor_id, regulatedActorId: ids.regulated_actor_id, rail: country === 'CG' ? 'mobile_money' : 'stripe',
        provider: country === 'CG' ? 'pawapay' : 'stripe', providerConfigurationKey: null,
        percentageBps: 300, fixedAmount: 1,
      });
      expect(Number(prepared.total_amount)).toBe(minor);
      expect(Number(prepared.external_amount)).toBe(minor);
      expect(Number(prepared.tax_amount)).toBe(0);
      if (country === 'CG') {
        const funding = await apiPaymentCheckoutService.getMobileMoneyOrder(result.checkoutToken!, { userId } as any);
        expect(toPawaPayAmount(currency, funding.externalAmount)).toBe(String(minor));
      } else {
        expect(toStripeAmount(currency, Number(order.total_amount), order.amount_unit)).toBe(minor);
        const funding = await apiPaymentCheckoutService.getStripeOrder(result.checkoutToken!, { userId } as any);
        expect(funding.providerExpectedAmount).toBe(minor);
        stripeCalls.create.mockClear();
        const response = await createStripeIntent({ params: { token: result.checkoutToken }, locals: { user: { id: userId } } } as any);
        expect(response.status).toBe(201);
        expect(stripeCalls.create).toHaveBeenCalledOnce();
        const { rows: [initiated] } = await pool.query('SELECT state,order_metadata FROM konektag.api_payment_orders WHERE id=$1', [order.id]);
        expect(initiated.state).toBe('processing');
        expect(initiated.order_metadata.erpnextPointsK.stripeInitiatedAt).toBeTruthy();
        await pool.query("UPDATE konektag.api_payment_orders SET created_at=now()-interval '2 days' WHERE id=$1", [order.id]);
        expect((await apiPaymentCheckoutService.getPublicOrder(result.checkoutToken!)).state).toBe('processing');
        expect(stripeCalls.create.mock.calls[0][0]).toMatchObject({ amount: minor, currency: currency.toLowerCase() });
      }
      await pool.query(`UPDATE konektag.api_payment_orders SET amount_unit='MAJOR' WHERE id=$1`, [order.id]);
      await expect(apiPaymentCheckoutService.prepareFundingOrder(result.checkoutToken!))
        .rejects.toThrow('amount unit must be corrected');
    });
  }
});
