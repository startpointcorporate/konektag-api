import { describe, expect, it, vi } from 'vitest';
// Unit-only isolation: real production acceptance uses no module mocks.
vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: { createWalletRechargeOrder: vi.fn(() => { throw new Error('Unexpected payment order creation'); }) },
}));
import { createPointsKCheckout, readPointsKCheckout } from '../../src/application/services/pay/points-k-checkout-service.ts';

const route: any = { site: 'EUROPE', slug: 'konektag-fr', paymentCountry: 'FR' };
function fixture(docstatus = 0) {
  const docs: Record<string, any> = {
    Customer: { CUST: { name: 'CUST', alias: 'kc', lead_name: 'LEAD' } },
    Quotation: { QTN: { name: 'QTN', docstatus, quotation_to: 'Lead', party_name: 'LEAD', currency: 'EUR',
      disable_rounded_total: 0, rounded_total: 12.21, items: [{ item_code: 'K', qty: 11 }] } },
  };
  const site: any = {
    key: 'EUROPE', host: 'erp.invalid',
    get: vi.fn(async (type: string, name: string) => docs[type]?.[name]),
    list: vi.fn(async (type: string) => type === 'Customer' ? [{ name: 'CUST' }]
      : type === 'Mode of Payment' ? [{ name: 'CB', type: 'Bank', enabled: 1 }]
      : type === 'Sales Order' ? [] : type === 'Payment Request' ? [] : []),
    insert: vi.fn(async (type: string, doc: any) => type === 'Sales Order'
      ? { ...doc, name: 'SO', docstatus: 0 } : doc),
    call: vi.fn(async (method: string, args: any) => {
      if (method.endsWith('make_sales_order')) return { customer: 'CUST', company: 'COMPANY', order_type: 'Sales', transaction_date: '2026-11-11', currency: 'EUR', items: [{ prevdoc_docname: 'QTN' }] };
      if (method.endsWith('make_payment_request')) return { name: 'PR', docstatus: 1, reference_doctype: 'Sales Order', reference_name: 'SO', party: 'CUST', currency: 'EUR', grand_total: 12.21 };
      const doc = { ...args.doc, docstatus: 1 };
      if (doc.name === 'QTN') docs.Quotation.QTN = doc;
      return doc;
    }),
  };
  const context: any = { resolveForRoute: vi.fn(async () => ({ country: 'FR', konektagSite: 'konektag-fr', currency: 'EUR',
    legalEntity: { id: 'LE', code: 'FR', legalName: 'France' }, providers: [] })) };
  return { site, context };
}

describe('Points K flow 2', () => {
  it('exposes only an owned complete quotation and site payment modes', async () => {
    const f = fixture();
    const result = await readPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN' },
      { route: async () => route, site: () => f.site, context: f.context });
    expect(result.amount).toBe(12.21);
    expect(result.modesOfPayment).toEqual([{ name: 'CB', type: 'Bank' }]);
  });

  it('submits the native chain and freezes ERPNext references in wallet metadata', async () => {
    const f = fixture();
    const createOrder = vi.fn(async (input: any) => ({ order: { id: 'order' }, checkoutToken: 'token', created: true, input }));
    const result = await createPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN', modeOfPayment: 'CB' },
      { route: async () => route, site: () => f.site, context: f.context, createOrder: createOrder as any });
    expect(result).toMatchObject({ salesOrder: 'SO', paymentRequest: 'PR', amount: 12.21, amountMinor: 1221 });
    expect(createOrder.mock.calls[0][0]).toMatchObject({ amount: 1221, amountUnit: 'MINOR', metadata: { erpnextPointsK: {
      version: 1, site: 'EUROPE', customer: 'CUST', quotation: 'QTN', salesOrder: 'SO', paymentRequest: 'PR', itemCode: 'K', quantityK: 11,
    } } });
  });
});

describe('Points K native preparation is separate from provider eligibility', () => {
  it('returns the owned ERPNext quotation when the provider profile is under review', async () => {
    const f = fixture();
    const { PaymentContextResolutionError } = await import('../../src/application/services/pay/payment-context-resolver.ts');
    f.context.resolveForRoute.mockRejectedValue(new PaymentContextResolutionError('PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND'));
    const result = await readPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN' },
      { route: async () => route, site: () => f.site, context: f.context });
    expect(result.amount).toBe(12.21);
    expect(result.paymentContext).toBeNull();
    expect(result.paymentContextError).toBe('PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND');
  });

  it('prepares the native documents without resolving a PSP context', async () => {
    const f = fixture();
    f.context.resolveForRoute.mockRejectedValue(new Error('Must not resolve providers during native preparation'));
    const createOrder = vi.fn(async () => ({ order: { id: 'order' }, checkoutToken: 'token', created: true }));
    const result = await createPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN', modeOfPayment: 'CB' },
      { route: async () => route, site: () => f.site, context: f.context, createOrder: createOrder as any });
    expect(result.paymentRequest).toBe('PR');
    expect(f.context.resolveForRoute).not.toHaveBeenCalled();
    expect(createOrder).toHaveBeenCalledOnce();
  });

  it('stops before native Payment Request submission if ERPNext would select a gateway', async () => {
    const f = fixture();
    const list = f.site.list.getMockImplementation()!;
    f.site.list.mockImplementation(async (type: string, ...args: any[]) => type === 'Payment Gateway Account' ? [{ name: 'GATEWAY' }] : list(type, ...args));
    const createOrder = vi.fn();
    await expect(createPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN', modeOfPayment: 'CB' },
      { route: async () => route, site: () => f.site, context: f.context, createOrder })).rejects.toMatchObject({ code: 'PAYMENT_REQUEST_EXTERNAL_GATEWAY_CONFIGURED' });
    expect(f.site.call.mock.calls.some(([method]: any[]) => method.endsWith('make_payment_request'))).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
  });
});


describe('Points K native Sales Order delivery dates', () => {
  async function run(mapped: any) {
    const f = fixture();
    const call = f.site.call.getMockImplementation()!;
    f.site.call.mockImplementation(async (method: string, args: any) => method.endsWith('make_sales_order')
      ? { customer: 'CUST', company: 'COMPANY', order_type: 'Sales', currency: 'EUR', items: [{ prevdoc_docname: 'QTN' }], ...mapped }
      : call(method, args));
    const promise = createPointsKCheckout({ keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN', modeOfPayment: 'CB' },
      { route: async () => route, site: () => f.site, context: f.context,
        createOrder: vi.fn(async () => ({ order: { id: 'order' }, checkoutToken: 'token', created: true })) as any });
    return { f, promise };
  }
  it('fills only the missing header from the native order date before inserting', async () => {
    const { f, promise } = await run({ transaction_date: '2030-02-03' });
    await promise;
    const doc = f.site.insert.mock.calls[0][1];
    expect(doc.delivery_date).toBe('2030-02-03');
    expect(doc.items[0].delivery_date).toBeUndefined(); // ERPNext propagates it.
  });
  it('preserves an existing header schedule', async () => {
    const { f, promise } = await run({ transaction_date: '2030-02-03', delivery_date: '2030-03-09' });
    await promise;
    expect(f.site.insert.mock.calls[0][1].delivery_date).toBe('2030-03-09');
  });
  it('leaves dated lines for native header aggregation', async () => {
    const { f, promise } = await run({ transaction_date: '2030-02-03', items: [{ prevdoc_docname: 'QTN', delivery_date: '2030-04-05' }] });
    await promise;
    expect(f.site.insert.mock.calls[0][1].delivery_date).toBeUndefined();
    expect(f.site.insert.mock.calls[0][1].items[0].delivery_date).toBe('2030-04-05');
  });
  for (const mapped of [{ order_type: 'Maintenance' }, { skip_delivery_note: 1 }]) {
    it('does not require a delivery date when native validation does not require it: ' + JSON.stringify(mapped), async () => {
      const { f, promise } = await run(mapped);
      await promise;
      expect(f.site.insert.mock.calls[0][1].delivery_date).toBeUndefined();
    });
  }
  it('refuses to invent a date when the mapper has no native order date', async () => {
    const { f, promise } = await run({});
    await expect(promise).rejects.toMatchObject({ code: 'SALES_ORDER_DELIVERY_DATE_UNAVAILABLE' });
    expect(f.site.insert).not.toHaveBeenCalled();
  });
});

describe('Points K country payment mode restrictions', () => {
  const input = { keycloakId: 'kc', userId: 'u', country: 'FR', customer: 'CUST', quotation: 'QTN' };
  for (const [country, expected] of Object.entries({ FR: ['CB', 'Virement Bancaire'], LB: ['Cash', 'Wire Transfer'], CG: ['Mobile Money', 'Cash', 'Wire Transfer'] })) {
    it(`filters enabled native modes for routed ${country}, independently of residence`, async () => {
      const f = fixture();
      const list = f.site.list.getMockImplementation()!;
      f.site.list.mockImplementation(async (type: string, ...args: any[]) => type === 'Mode of Payment'
        ? ['CB', 'Virement Bancaire', 'Cash', 'Wire Transfer', 'Mobile Money', 'Konektag Link Pay', 'Link pay', 'Cheque'].map(name => ({ name, type: 'Bank', enabled: 1 }))
        : list(type, ...args));
      const result = await readPointsKCheckout({ ...input, country: 'BE' }, { route: async () => ({ ...route, paymentCountry: country }), site: () => f.site, context: f.context });
      expect(result.modesOfPayment.map(mode => mode.name)).toEqual(expected);
    });
  }
  for (const mode of ['Konektag Link Pay', 'Link pay', 'Cash', 'Wire Transfer']) {
    it(`rejects a forged France submission of ${mode} before native writes`, async () => {
      const f = fixture();
      const list = f.site.list.getMockImplementation()!;
      f.site.list.mockImplementation(async (type: string, ...args: any[]) => type === 'Mode of Payment'
        ? [{ name: mode, enabled: 1 }] : list(type, ...args));
      await expect(createPointsKCheckout({ ...input, modeOfPayment: mode }, { route: async () => route, site: () => f.site }))
        .rejects.toMatchObject({ code: 'MODE_OF_PAYMENT_NOT_ALLOWED' });
      expect(f.site.call).not.toHaveBeenCalled();
      expect(f.site.insert).not.toHaveBeenCalled();
    });
  }
  it('does not invent missing or disabled native modes', async () => {
    const f = fixture();
    const list = f.site.list.getMockImplementation()!;
    f.site.list.mockImplementation(async (type: string, ...args: any[]) => type === 'Mode of Payment'
      ? [{ name: 'CB', enabled: 0 }] : list(type, ...args));
    const result = await readPointsKCheckout(input, { route: async () => route, site: () => f.site, context: f.context });
    expect(result.modesOfPayment).toEqual([]);
  });
});
