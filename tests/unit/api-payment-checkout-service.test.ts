import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
}));

const webhookMocks = vi.hoisted(() => ({
  enqueueAndDeliverPaymentSucceeded: vi.fn(),
  enqueuePaymentSucceeded: vi.fn(),
  enqueuePaymentEvent: vi.fn(),
  deliverPaymentSucceeded: vi.fn(),
}));

const accountingMocks = vi.hoisted(() => ({
  postTransaction: vi.fn(),
}));

const redisMocks = vi.hoisted(() => ({
  publishPaymentStatus: vi.fn(),
}));

const walletAuthorizationMocks = vi.hoisted(() => ({
  issue: vi.fn(),
  verifyApiPayment: vi.fn(),
}));

const paymentContextMocks = vi.hoisted(() => ({
  verifyPaymentContextSelection: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool', () => ({
  default: { query: mocks.poolQuery, connect: mocks.connect },
}));
vi.mock('../../src/application/services/pay/api-payment-webhook-service', () => ({
  apiPaymentWebhookService: webhookMocks,
}));
vi.mock('../../src/application/services/accounting-service', () => ({
  accountingService: accountingMocks,
}));
vi.mock('../../src/infrastructure/adapters/redis-adapter', () => ({
  redisAdapter: redisMocks,
}));
vi.mock('../../src/application/services/pay/wallet-debit-authorization-service', () => ({
  walletDebitAuthorizationService: walletAuthorizationMocks,
}));
// Funding tests use an explicit unit valuation: one source minor unit per K.
// Official valuation and SQL wallet invariants are exercised separately.
vi.mock('../../src/application/services/points-k-valuation-service', async () => {
  const actual = await import('../helpers/points-k-valuation-stub');
  return { ...actual.pointsKValuationModule, valuePointsK: async (input: {sourceCurrency:string;sourceAmountMinor:number}) => ({
    ...actual.stubValuation(input.sourceCurrency,input.sourceAmountMinor), quantityK:input.sourceAmountMinor,
  }) };
});
vi.mock('../../src/application/services/pay/points-wallet-service', () => ({
  pointsBalance: vi.fn(async (_party: string, db: { query: (sql: string, values?: unknown[]) => Promise<any> }) => {
    const result = await db.query('SELECT * FROM konektag.points_balance($1)', [_party]);
    return { available: Number(result.rows?.[0]?.balance ?? 0) };
  }),
}));
vi.mock('../../src/application/services/pay/payment-context-resolver', () => ({
  verifyPaymentContextSelection: paymentContextMocks.verifyPaymentContextSelection,
}));

import {
  apiPaymentCheckoutService,
  ApiPaymentValidationError,
  ApiPaymentNetworkOperationGuideRequiredError,
  buildApiPaymentAccountingCommand,
  buildNetworkApiPaymentAccountingCommand,
  toStripeAmount,
} from '../../src/application/services/pay/api-payment-checkout-service';

const pendingOrder = {
  id: 'order-1',
  merchant_profile_id: 'merchant-1',
  environment: 'sandbox' as const,
  merchant_transaction_id: 'merchant-tx-1',
  label: 'Order label',
  payer_identity: 'payer@example.test',
  currency: 'XOF',
  subtotal_amount: 10_000,
  tax_amount: 500,
  fee_amount: 315,
  cashback_amount: 100,
  total_amount: 10_815,
  state: 'pending' as const,
  payment_method: null,
  stripe_payment_intent_id: null,
  wallet_available_amount: 0,
  wallet_amount: 0,
  wallet_contribution_amount: 0,
  external_amount: 10_815,
  payer_party_id: null,
  funding_state: 'unprepared' as const,
  settlement_legal_entity_id: null,
  settlement_regulatory_profile_id: null,
  settlement_corridor_id: null,
  settlement_regulated_actor_id: null,
  settlement_rail: null,
  settlement_provider: null,
  created_at: '2099-07-24T00:00:00.000Z',
  updated_at: '2099-07-24T00:00:00.000Z',
  paid_at: null,
  version: 1,
};

describe('apiPaymentCheckoutService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    webhookMocks.enqueueAndDeliverPaymentSucceeded.mockResolvedValue(undefined);
    webhookMocks.enqueuePaymentSucceeded.mockResolvedValue('delivery-1');
    webhookMocks.deliverPaymentSucceeded.mockResolvedValue(undefined);
    accountingMocks.postTransaction.mockResolvedValue({ success: true, financialTransactionId: 'financial-1', created: true });
    redisMocks.publishPaymentStatus.mockResolvedValue(undefined);
    paymentContextMocks.verifyPaymentContextSelection.mockReset();
  });

  it('creates an order without a fee until a Payment Context resolves one', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ ...pendingOrder, fee_amount: 0, total_amount: 10_500, external_amount: 10_500 }] });

    const result = await apiPaymentCheckoutService.createOrder({
      merchantProfileId: 'merchant-1',
      environment: 'sandbox',
      merchantTransactionId: 'merchant-tx-1',
      label: 'Order label',
      payerIdentity: 'payer@example.test',
      currency: 'XOF',
      subtotalAmount: 10_000,
      taxAmount: 500,
      cashbackAmount: 100,
    });

    expect(result.order.feeAmount).toBe(0);
    expect(result.order.totalAmount).toBe(10_500);
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual(expect.arrayContaining([0, 100, 10_500]));
    expect(mocks.poolQuery.mock.calls[0][0]).toContain('wallet_available_amount, wallet_amount, external_amount');
  });

  it('creates a live merchantless NETWORK wallet recharge for its target user', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{
      ...pendingOrder, merchant_profile_id: null, order_purpose: 'wallet_recharge', target_user_id: 'user-1',
      environment: 'live', merchant_transaction_id: 'WALLET-RECHARGE-1', label: 'Wallet recharge',
      payer_identity: 'user:user-1', subtotal_amount: 2500, tax_amount: 0, fee_amount: 0,
      total_amount: 2500, external_amount: 2500, beneficiary_type: 'NETWORK', beneficiary_party_id: null,
    }] });

    const result = await apiPaymentCheckoutService.createWalletRechargeOrder({
      targetUserId: 'user-1', currency: 'EUR', amount: 2500, paymentCountry: 'FR',
    });

    expect(result.order).toMatchObject({ environment: 'live', merchant: { name: 'Konektag' }, totalAmount: 2500 });
    expect(result.order).toMatchObject({ merchant: { name: 'Konektag' } });
    expect(mocks.poolQuery.mock.calls[0][0]).toContain("'wallet_recharge'");
    expect(mocks.poolQuery.mock.calls[0][0]).toContain("'NETWORK'");
    expect(mocks.poolQuery.mock.calls[0][0]).toContain("NULL, 'wallet_recharge'");
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual(expect.arrayContaining(['user-1', 'EUR', 2500]));
  });

  it('persists an explicit MINOR unit for ERPNext-backed wallet recharges', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{
      ...pendingOrder, merchant_profile_id: null, order_purpose: 'wallet_recharge', target_user_id: 'user-1',
      environment: 'live', amount_unit: 'MINOR', currency: 'EUR', subtotal_amount: 1200,
      total_amount: 1200, external_amount: 1200, beneficiary_type: 'NETWORK',
    }] });

    const result = await apiPaymentCheckoutService.createWalletRechargeOrder({
      targetUserId: 'user-1', currency: 'EUR', amount: 1200, amountUnit: 'MINOR', paymentCountry: 'FR',
      metadata: { erpnextPointsK: { paymentRequest: 'PR-1' } },
    });

    const [sql, params] = mocks.poolQuery.mock.calls[0];
    expect(sql).toContain('payment_country, amount_unit');
    expect(params).toEqual(expect.arrayContaining(['EUR', 1200, 'MINOR']));
    expect(result.order).toMatchObject({ totalAmount: 1200, amountUnit: 'MINOR' });
  });

  it('persists the explicit unit of a Points K recharge and preserves the legacy default', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ ...pendingOrder, amount_unit: 'MINOR' }] });
    await apiPaymentCheckoutService.createWalletRechargeOrder({ targetUserId: 'u', currency: 'EUR', amount: 1200,
      amountUnit: 'MINOR', paymentCountry: 'FR', metadata: { erpnextPointsK: { paymentRequest: 'PR' } } });
    const [sql, values] = mocks.poolQuery.mock.calls[0];
    expect(sql).toContain('payment_country, amount_unit');
    expect(values[8]).toBe('MINOR');
    await apiPaymentCheckoutService.createWalletRechargeOrder({ targetUserId: 'u', currency: 'EUR', amount: 12, paymentCountry: 'FR' });
    expect(mocks.poolQuery.mock.calls[1][1][8]).toBe('MAJOR');
  });

  it('rejects a Points K recharge with a missing or invalid amount unit before insertion', async () => {
    for (const amountUnit of [undefined, 'MAJOR', 'invalid']) {
      await expect(apiPaymentCheckoutService.createWalletRechargeOrder({ targetUserId: 'u', currency: 'EUR', amount: 1200,
        amountUnit: amountUnit as any, paymentCountry: 'FR', metadata: { erpnextPointsK: { paymentRequest: 'PR' } } }))
        .rejects.toBeInstanceOf(ApiPaymentValidationError);
    }
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('refuses to fund an old ERPNext order labelled MAJOR before any provider call', async () => {
    mocks.clientQuery.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ ...pendingOrder, amount_unit: 'MAJOR', order_metadata: { erpnextPointsK: { paymentRequest: 'PR' } } }] })
      .mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.getStripeOrder('raw-token')).rejects.toThrow('amount unit must be corrected');
    expect(mocks.clientQuery.mock.calls.map(call => call[0])).toEqual(['BEGIN', expect.stringContaining('SELECT *'), 'ROLLBACK']);
  });

  it('calculates the Stripe percentage fee from the minor-unit principal exactly once', async () => {
    const order = { ...pendingOrder, environment: 'live', business_purpose: 'pro_subscription_renewal',
      amount_unit: 'MINOR', currency: 'EUR', subtotal_amount: 1200, tax_amount: 0, order_metadata: { paymentCountry: 'FR' } };
    const context = { currency: 'EUR', paymentCountry: 'FR', legalEntityId: 'le', regulatoryProfileId: 'profile',
      corridorId: 'corridor', regulatedActorId: 'actor', rail: 'stripe', provider: 'stripe',
      providerConfigurationKey: 'STRIPE_TEST', percentageBps: 300, fixedAmount: 0 };
    mocks.clientQuery.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [order] })
      .mockResolvedValueOnce({ rows: [{ ...order, funding_state: 'prepared' }] }).mockResolvedValueOnce(undefined);
    await apiPaymentCheckoutService.prepareFundingOrder('raw-token', undefined, context);
    const update = mocks.clientQuery.mock.calls.find(call => String(call[0]).includes('SET wallet_available_amount'))!;
    expect(update[1][16]).toBe(1236); // 1200 cents + 36 cents, not 1200 + 3600.
  });

  it('expires an old non-terminal checkout when loading the public order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    const staleOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      state: 'pending' as const,
      created_at: '2026-08-10T09:30:00.000Z',
      merchant_name: 'Merchant',
      merchant_logo_url: null,
    };
    const expiredOrder = {
      ...staleOrder,
      state: 'expired' as const,
      version: 2,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [staleOrder] })
      .mockResolvedValueOnce({ rows: [expiredOrder] })
      .mockResolvedValueOnce(undefined);

    try {
      await expect(apiPaymentCheckoutService.getPublicOrder('raw-token')).resolves.toMatchObject({
        id: 'order-1',
        state: 'expired',
      });
      const updateCall = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('UPDATE konektag.api_payment_orders'))!;
      expect(updateCall[1]).toEqual(['expired', null, null, 'order-1', 1, false]);
      expect(redisMocks.publishPaymentStatus).toHaveBeenCalledWith('order-1', expect.objectContaining({
        state: 'expired',
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['processing', 'awaiting_mobile_money'])('does not expire an unresolved Points K %s payment on refresh', async state => {
    const order = { ...pendingOrder, state, created_at: '2000-01-01T00:00:00Z',
      order_metadata: { erpnextPointsK: { provider: state === 'processing' ? 'stripe' : 'pawapay' } } };
    mocks.clientQuery.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [order] }).mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.getPublicOrder('raw-token')).resolves.toMatchObject({ state });
    expect(mocks.clientQuery.mock.calls.some(call => String(call[0]).includes('UPDATE konektag.api_payment_orders'))).toBe(false);
  });

  it.each(['paid', 'failed', 'expired', 'cancelled'])('rejects a terminal %s checkout moving back to processing', async state => {
    await expect(apiPaymentCheckoutService.updateState({ query: vi.fn() } as any,
      { ...pendingOrder, state } as any, 'processing')).rejects.toThrow('Cannot transition');
  });

  it('keeps a recent checkout active when loading the public order', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    const freshOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      state: 'pending' as const,
      created_at: '2026-08-10T11:45:00.000Z',
      merchant_name: 'Merchant',
      merchant_logo_url: null,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [freshOrder] })
      .mockResolvedValueOnce(undefined);

    try {
      await expect(apiPaymentCheckoutService.getPublicOrder('raw-token')).resolves.toMatchObject({
        id: 'order-1',
        state: 'pending',
      });
      expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('UPDATE konektag.api_payment_orders'))).toBe(false);
      expect(redisMocks.publishPaymentStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires a beneficiary to accompany an already selected Payment Context before Stripe starts', async () => {
    const selectedOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      funding_state: 'prepared' as const,
      settlement_legal_entity_id: 'legal-entity-1',
      settlement_regulatory_profile_id: 'profile-1',
      settlement_corridor_id: 'corridor-1',
      settlement_rail: 'stripe',
      settlement_provider: 'stripe',
      beneficiary_type: null,
      beneficiary_party_id: null,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [selectedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'NETWORK' }] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.getStripeOrder('raw-token'))
      .rejects.toThrow('Checkout Payment Request has not been frozen');
  });

  it('freezes a signed Stripe selection and its fee for a NETWORK wallet recharge', async () => {
    const rechargeOrder = { ...pendingOrder, merchant_profile_id: null, order_purpose: 'wallet_recharge', target_user_id: 'user-1',
      environment: 'live' as const, currency: 'EUR', subtotal_amount: 100, tax_amount: 0, fee_amount: 0, total_amount: 100, external_amount: 100 };
    const selectedOrder = { ...rechargeOrder, funding_state: 'prepared' as const, fee_amount: 3, total_amount: 103, external_amount: 103, version: 2,
      settlement_legal_entity_id: 'legal-entity-1', settlement_regulatory_profile_id: 'profile-1', settlement_corridor_id: 'KTG-FR-KTG-FR',
      settlement_regulated_actor_id: 'actor-1', settlement_rail: 'stripe', settlement_provider: 'stripe', provider_configuration_key: 'KTG_FR_STRIPE_TEST',
      beneficiary_type: 'NETWORK' as const, beneficiary_party_id: null };
    paymentContextMocks.verifyPaymentContextSelection.mockReturnValue({
      country: 'FR', legalEntityCode: 'KTG-FR', currency: 'EUR', regulatoryProfileCode: 'LINK-FR-STRIPE', rail: 'stripe',
      corridor: 'KTG-FR-KTG-FR', regulatedActorCode: 'STRIPE-FR', provider: 'stripe', providerConfigurationKey: 'KTG_FR_STRIPE_TEST',
      paymentMethod: 'card', fees: { percentageBps: 300, fixedAmount: 0 }, expiresAt: '2099-01-01T00:00:00.000Z',
    });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ legal_entity_id: 'legal-entity-1', regulatory_profile_id: 'profile-1', corridor_id: 'KTG-FR-KTG-FR', regulated_actor_id: 'actor-1', rail: 'stripe' }] });
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [rechargeOrder] })
      .mockResolvedValueOnce({ rows: [] }) // no applicable recharge tax
      .mockResolvedValueOnce({ rows: [selectedOrder] })
      .mockResolvedValueOnce(undefined);

    await apiPaymentCheckoutService.prepareSelectedFunding('raw-token', undefined, 'signed-selection');

    expect(paymentContextMocks.verifyPaymentContextSelection).toHaveBeenCalledWith('signed-selection');
    const update = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('settlement_legal_entity_id'))!;
    expect(update[0]).toContain('WHERE id = $18 AND version = $19');
    expect(update[1]).toEqual([0, 0, 103, 3, 103, null, 'legal-entity-1', 'profile-1', 'KTG-FR-KTG-FR', 'actor-1', 'stripe', 'stripe', 'KTG_FR_STRIPE_TEST', 'FR', 'NETWORK', null, 10300, 'order-1', 1, 0, 0]);
  });

  it('returns PawaPay country, configuration, and external amount from the frozen snapshot', async () => {
    const frozenOrder = {
      ...pendingOrder, environment: 'live' as const, currency: 'XAF', state: 'awaiting_mobile_money' as const,
      payment_method: 'mobile_money' as const, funding_state: 'external_started' as const,
      external_amount: 12_345, settlement_legal_entity_id: 'legal-entity-cm', settlement_regulatory_profile_id: 'profile-cm',
      settlement_corridor_id: 'KTG-CM-KTG-CM', settlement_rail: 'mobile_money', settlement_provider: 'pawapay',
      provider_configuration_key: 'KTG_CM_PAWAPAY_SANDBOX', payment_country: 'CM', beneficiary_type: 'NETWORK' as const,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [frozenOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'NETWORK' }] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.getMobileMoneyOrder('raw-token')).resolves.toEqual({
      id: 'order-1', currency: 'XAF', externalAmount: 12_345, paymentCountry: 'CMR', providerConfigurationKey: 'KTG_CM_PAWAPAY_SANDBOX',
      amountUnit: 'MAJOR', pointsK: false,
    });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it('freezes a Pro PawaPay quote on its original country and NETWORK beneficiary', async () => {
    const proOrder = {
      ...pendingOrder, environment: 'live' as const, business_purpose: 'pro_subscription_renewal',
      amount_unit: 'MINOR', currency: 'XAF', subtotal_amount: 58_380, tax_amount: 0,
      total_amount: 58_380, external_amount: 58_380,
      order_metadata: { paymentCountry: 'CG', merchantProfileId: 'subscriber-1' },
    };
    const context = {
      currency: 'XAF', paymentCountry: 'CG', legalEntityId: 'legal-entity-cg',
      regulatoryProfileId: 'profile-cg', corridorId: 'KTG-CG-KTG-CG',
      regulatedActorId: 'actor-cg', rail: 'mobile_money', provider: 'pawapay',
      providerConfigurationKey: 'KTG_CG_PAWAPAY_LIVE', percentageBps: 300, fixedAmount: 0,
    };
    mocks.clientQuery.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [proOrder] })
      .mockResolvedValueOnce({ rows: [{ ...proOrder, funding_state: 'prepared' }] })
      .mockResolvedValueOnce(undefined);
    await apiPaymentCheckoutService.prepareFundingOrder('raw-token', undefined, context);
    const update = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('settlement_legal_entity_id'))!;
    expect(update[1]).toEqual(expect.arrayContaining(['CG', 'NETWORK', null]));
    expect(update[1][3]).toBe(0);
    expect(update[1][4]).toBe(58_380);

    mocks.clientQuery.mockReset();
    mocks.clientQuery.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ rows: [proOrder] })
      .mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.prepareFundingOrder('raw-token', undefined,
      { ...context, paymentCountry: 'CM' })).rejects.toThrow('another payment country');
  });

  it('normalizes an alpha-3 payment country to the legal-entity alpha-2 code set', async () => {
    paymentContextMocks.verifyPaymentContextSelection.mockReturnValue({
      country: 'COG',
      legalEntityCode: 'KTG-CG',
      currency: 'XAF',
      regulatoryProfileCode: 'LINK-CG-STRIPE',
      rail: 'stripe',
      corridor: 'KTG-CG-KTG-CG',
      regulatedActorCode: 'STRIPE-CG',
      provider: 'stripe',
      providerConfigurationKey: 'KTG_CG_STRIPE_TEST',
      paymentMethod: 'card',
      fees: { percentageBps: 300, fixedAmount: 0 },
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ legal_entity_id: 'legal-entity-cg', regulatory_profile_id: 'profile-cg', corridor_id: 'KTG-CG-KTG-CG', regulated_actor_id: 'actor-cg', rail: 'stripe' }] });
    mocks.clientQuery.mockResolvedValue(undefined);
    mocks.clientQuery.mockRejectedValueOnce(new Error('stop-after-country-normalization'));

    await expect(apiPaymentCheckoutService.prepareSelectedFunding('raw-token', undefined, 'signed-selection'))
      .rejects.toThrow('stop-after-country-normalization');
    expect(mocks.poolQuery.mock.calls[0][1][7]).toEqual(['CG']);
  });

  it('charges no external fee when Points K fully cover the basket', async () => {
    const unpricedOrder = { ...pendingOrder, environment: 'live' as const, subtotal_amount: 100, tax_amount: 0, fee_amount: 0, total_amount: 100, external_amount: 100 };
    const fundedOrder = { ...unpricedOrder, wallet_available_amount: 101, wallet_amount: 100, fee_amount: 0, total_amount: 100, external_amount: 0, funding_state: 'prepared' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [unpricedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'payer-party' }] })
      .mockResolvedValueOnce({ rows: [{ balance: 101 }] })
      .mockResolvedValueOnce({ rows: [fundedOrder] })
      .mockResolvedValueOnce(undefined);

    const result = await apiPaymentCheckoutService.prepareFunding('raw-token', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer',
    }, { percentageBps: 100, fixedAmount: 0, currency: 'XOF' });

    expect(result).toMatchObject({ walletAmount: 100, externalAmount: 0 });
    const update = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('SET wallet_available_amount'))!;
    expect(update[1]).toEqual([101, 100, 0, 0, 100, 'payer-party', 'order-1', 1]);
  });

  it('keeps the remaining principal external when Points K do not cover the basket', async () => {
    const unpricedOrder = { ...pendingOrder, environment: 'live' as const, subtotal_amount: 100, tax_amount: 0, fee_amount: 0, total_amount: 100, external_amount: 100 };
    const fundedOrder = { ...unpricedOrder, wallet_available_amount: 99, wallet_amount: 99, fee_amount: 0, total_amount: 100, external_amount: 1, funding_state: 'prepared' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [unpricedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'payer-party' }] })
      .mockResolvedValueOnce({ rows: [{ balance: 99 }] })
      .mockResolvedValueOnce({ rows: [fundedOrder] })
      .mockResolvedValueOnce(undefined);

    const result = await apiPaymentCheckoutService.prepareFunding('raw-token', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer',
    }, { percentageBps: 100, fixedAmount: 0, currency: 'XOF' });

    expect(result).toMatchObject({ walletAmount: 99, externalAmount: 1 });
    const update = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('SET wallet_available_amount'))!;
    expect(update[1]).toEqual([99, 99, 1, 0, 100, 'payer-party', 'order-1', 1]);
  });

  it('applies the selected card fee only on the externally funded remainder', async () => {
    const unpricedOrder = { ...pendingOrder, environment: 'live' as const, subtotal_amount: 100, tax_amount: 0, fee_amount: 0, total_amount: 100, external_amount: 100 };
    const fundedOrder = { ...unpricedOrder, wallet_available_amount: 50, wallet_amount: 50, fee_amount: 2, total_amount: 102, external_amount: 52, funding_state: 'prepared' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [unpricedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'payer-party' }] })
      .mockResolvedValueOnce({ rows: [{ balance: 50 }] })
      .mockResolvedValueOnce({ rows: [fundedOrder] })
      .mockResolvedValueOnce(undefined);
    const result = await apiPaymentCheckoutService.prepareFunding('raw-token', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer',
    }, { percentageBps: 300, fixedAmount: 0, currency: 'XOF' });

    expect(result).toMatchObject({ walletAmount: 50, externalAmount: 52 });
    const update = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('SET wallet_available_amount'))!;
    expect(update[1]).toEqual([50, 50, 52, 2, 102, 'payer-party', 'order-1', 1]);
  });

  it('fails explicitly when the selected payment method has no fee context', async () => {
    const unpricedOrder = { ...pendingOrder, environment: 'live' as const, subtotal_amount: 100, tax_amount: 0, fee_amount: 0, total_amount: 100, external_amount: 100 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [unpricedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'payer-party' }] })
      .mockResolvedValueOnce({ rows: [{ balance: 50 }] })
      .mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.prepareFunding('raw-token', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer',
    })).rejects.toThrow('Payment funding requires a payment fee context');
  });

  it('adds fixed fees from the selected payment context', async () => {
    const unpricedOrder = { ...pendingOrder, environment: 'live' as const, subtotal_amount: 100, tax_amount: 0, fee_amount: 0, total_amount: 100, external_amount: 100 };
    const fundedOrder = { ...unpricedOrder, wallet_available_amount: 0, wallet_amount: 0, fee_amount: 2, total_amount: 102, external_amount: 102, funding_state: 'prepared' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [unpricedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [fundedOrder] })
      .mockResolvedValueOnce(undefined);

    await apiPaymentCheckoutService.prepareFunding('raw-token', undefined, { percentageBps: 0, fixedAmount: 2, currency: 'XOF' });

    const update = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('SET wallet_available_amount'))!;
    expect(update[1]).toEqual([0, 0, 102, 2, 102, null, 'order-1', 1]);
  });

  it('adds percentage and fixed fees from the selected payment context', async () => {
    const unpricedOrder = { ...pendingOrder, environment: 'live' as const, subtotal_amount: 100, tax_amount: 0, fee_amount: 0, total_amount: 100, external_amount: 100 };
    const fundedOrder = { ...unpricedOrder, wallet_available_amount: 0, wallet_amount: 0, fee_amount: 5, total_amount: 105, external_amount: 105, funding_state: 'prepared' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [unpricedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [fundedOrder] })
      .mockResolvedValueOnce(undefined);

    await apiPaymentCheckoutService.prepareFunding('raw-token', undefined, { percentageBps: 300, fixedAmount: 2, currency: 'XOF' });

    const update = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('SET wallet_available_amount'))!;
    expect(update[1]).toEqual([0, 0, 105, 5, 105, null, 'order-1', 1]);
  });

  it('converts only supported checkout currencies to Stripe minor units', () => {
    expect(toStripeAmount('XOF', 10_815)).toBe(10_815);
    expect(toStripeAmount('EUR', 108)).toBe(10_800);
    expect(toStripeAmount('EUR', 1_200, 'MINOR')).toBe(1_200);
    expect(toStripeAmount('USD', 1_221, 'MINOR')).toBe(1_221);
    expect(() => toStripeAmount('XYZ', 108)).toThrow(ApiPaymentValidationError);
  });

  it('stores a live card PaymentIntent by optimistic state transition without marking it paid', async () => {
    const liveOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      funding_state: 'prepared' as const,
    };
    const processingOrder = {
      ...liveOrder,
      state: 'processing' as const,
      payment_method: 'card' as const,
      stripe_payment_intent_id: 'pi_123',
      version: 2,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [liveOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [processingOrder] })
      .mockResolvedValueOnce(undefined);

    const result = await apiPaymentCheckoutService.attachStripePaymentIntent('raw-token', 'pi_123');

    expect(result.stripePaymentIntentId).toBe('pi_123');
    const stateUpdate = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes("state = 'processing'"))!;
    expect(stateUpdate[0]).not.toContain("state = 'paid'");
    expect(stateUpdate[0]).toContain('WHERE id = $2 AND version = $3');
    expect(redisMocks.publishPaymentStatus).toHaveBeenCalledWith('order-1', expect.objectContaining({
      state: 'processing', paymentMethod: 'card', paidAt: null,
    }));
  });

  it('marks sandbox orders paid without touching live payment integrations', async () => {
    const paidOrder = { ...pendingOrder, state: 'paid' as const, payment_method: 'sandbox' as const, version: 2, paid_at: '2026-07-24T01:00:00.000Z' };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [pendingOrder] })
      .mockResolvedValueOnce({ rows: [paidOrder] })
      .mockResolvedValueOnce(undefined);

    const result = await apiPaymentCheckoutService.confirmCheckout('raw-token', 'sandbox');

    expect(result.outcome).toBe('paid');
    expect(result.order.state).toBe('paid');
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('UPDATE konektag.api_payment_orders'))).toBe(true);
    const updateCall = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('UPDATE konektag.api_payment_orders'))!;
    expect(updateCall[0]).toContain('paid_at = CASE WHEN $6 THEN now()');
    expect(updateCall[1]).toEqual(['paid', 'sandbox', null, 'order-1', 1, true]);
    expect(webhookMocks.enqueuePaymentSucceeded).toHaveBeenCalledWith(expect.anything(), paidOrder);
    expect(webhookMocks.deliverPaymentSucceeded).toHaveBeenCalledWith('delivery-1');
    const commitIndex = mocks.clientQuery.mock.calls.findIndex((call: unknown[]) => call[0] === 'COMMIT');
    expect(webhookMocks.enqueuePaymentSucceeded.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.clientQuery.mock.invocationCallOrder[commitIndex]);
    expect(webhookMocks.deliverPaymentSucceeded.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.clientQuery.mock.invocationCallOrder[commitIndex]);
    expect(redisMocks.publishPaymentStatus).toHaveBeenCalledWith('order-1', expect.objectContaining({
      state: 'paid', paymentMethod: 'sandbox', paidAt: '2026-07-24T01:00:00.000Z',
    }));
    expect(redisMocks.publishPaymentStatus.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.clientQuery.mock.invocationCallOrder[commitIndex]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('leaves live Mobile Money awaiting provider confirmation', async () => {
    const liveOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      funding_state: 'prepared' as const,
    };
    const awaitingOrder = {
      ...liveOrder,
      state: 'awaiting_mobile_money' as const,
      payment_method: 'mobile_money' as const,
      funding_state: 'external_started' as const,
      version: 2,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [liveOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [liveOrder] })
      .mockResolvedValueOnce({ rows: [awaitingOrder] })
      .mockResolvedValueOnce(undefined);

    const result = await apiPaymentCheckoutService.confirmCheckout('raw-token', 'mobile_money');

    expect(result.outcome).toBe('awaiting_mobile_money');
    expect(result.order.state).toBe('awaiting_mobile_money');
    expect(redisMocks.publishPaymentStatus).toHaveBeenCalledWith('order-1', expect.objectContaining({
      state: 'awaiting_mobile_money', paymentMethod: 'mobile_money', paidAt: null,
    }));
  });

  it('does not roll back a committed payment when realtime publication fails', async () => {
    const paidOrder = { ...pendingOrder, state: 'paid' as const, payment_method: 'sandbox' as const, version: 2, paid_at: '2026-07-24T01:00:00.000Z' };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [pendingOrder] })
      .mockResolvedValueOnce({ rows: [paidOrder] })
      .mockResolvedValueOnce(undefined);
    redisMocks.publishPaymentStatus.mockRejectedValue(new Error('Redis unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(apiPaymentCheckoutService.confirmCheckout('raw-token', 'sandbox')).resolves.toMatchObject({ outcome: 'paid' });
    } finally {
      consoleError.mockRestore();
    }

    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => call[0] === 'COMMIT')).toBe(true);
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => call[0] === 'ROLLBACK')).toBe(false);
    expect(webhookMocks.enqueuePaymentSucceeded).toHaveBeenCalledWith(expect.anything(), paidOrder);
  });

  it('publishes the final paid status only after accounting and commit', async () => {
    const processingOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      state: 'processing' as const,
      payment_method: 'card' as const,
      funding_state: 'external_started' as const,
    };
    const paidOrder = {
      ...processingOrder,
      state: 'paid' as const,
      funding_state: 'finalized' as const,
      version: 2,
      paid_at: '2026-07-24T01:00:00.000Z',
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [processingOrder] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', provider: 'stripe', state: 'succeeded' }] })
      .mockResolvedValueOnce({ rows: [] }) // no other successful provider attempt
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [{ merchantPartyId: 'merchant-party-1', legalEntityId: 'legal-entity-1', regulatoryProfileId: 'reg-profile-1', corridorId: 'corridor-1', profile_count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'sale-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [paidOrder] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.markFinalAndDispatch('order-1', 'card', 'pi-verified'))
      .resolves.toMatchObject({ id: 'order-1', state: 'paid' });

    const commitIndex = mocks.clientQuery.mock.calls.findIndex((call: unknown[]) => call[0] === 'COMMIT');
    expect(webhookMocks.enqueuePaymentSucceeded).toHaveBeenCalledWith(expect.anything(), paidOrder);
    expect(webhookMocks.enqueuePaymentSucceeded.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.clientQuery.mock.invocationCallOrder[commitIndex]);
    expect(webhookMocks.deliverPaymentSucceeded).toHaveBeenCalledWith('delivery-1');
    expect(webhookMocks.deliverPaymentSucceeded.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.clientQuery.mock.invocationCallOrder[commitIndex]);
    expect(redisMocks.publishPaymentStatus).toHaveBeenCalledWith('order-1', expect.objectContaining({
      state: 'paid', paymentMethod: 'card', paidAt: '2026-07-24T01:00:00.000Z',
    }));
    expect(redisMocks.publishPaymentStatus.mock.invocationCallOrder[0])
      .toBeGreaterThan(mocks.clientQuery.mock.invocationCallOrder[commitIndex]);
  });

  it('posts NETWORK acquisition and fee_collection through existing guides without merchant liability or sale', async () => {
    const processingOrder = {
      ...pendingOrder, environment: 'live' as const, state: 'processing' as const,
      payment_method: 'card' as const, funding_state: 'external_started' as const,
    };
    const paidOrder = { ...processingOrder, state: 'paid' as const, funding_state: 'finalized' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [processingOrder] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', provider: 'stripe', state: 'succeeded' }] })
      .mockResolvedValueOnce({ rows: [] }) // no other successful provider attempt
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'NETWORK' }] })
      .mockResolvedValueOnce({ rows: [{ legalEntityId: 'legal-entity-1', regulatoryProfileId: 'reg-profile-1', corridorId: 'corridor-1', profile_count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ debit_account: '512000', credit_account: '467100' }] })
      .mockResolvedValueOnce({ rows: [{ debit_account: '467100', credit_account: '708000' }] })
      .mockResolvedValueOnce({ rows: [paidOrder] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.markFinalAndDispatch('order-1', 'card', 'pi-verified'))
      .resolves.toMatchObject({ id: 'order-1', state: 'paid' });

    expect(accountingMocks.postTransaction).toHaveBeenCalledTimes(2);
    const [acquisition, fee] = accountingMocks.postTransaction.mock.calls.map(([command]) => command);
    expect(acquisition.transactionType).toBe('acquisition');
    expect(fee.transactionType).toBe('fee_collection');
    expect([...acquisition.entries, ...fee.entries].some(entry => entry.accountCode === '2000')).toBe(false);
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT INTO konektag.merchant_sales'))).toBe(false);
  });

  it('uses the frozen NETWORK context and guides without resolving a merchant or dispatching a merchant webhook', async () => {
    const processingOrder = {
      ...pendingOrder, environment: 'live' as const, state: 'processing' as const,
      payment_method: 'card' as const, funding_state: 'external_started' as const,
      beneficiary_type: 'NETWORK' as const, beneficiary_party_id: null,
      settlement_legal_entity_id: 'legal-entity-1', settlement_regulatory_profile_id: 'reg-profile-1',
      settlement_corridor_id: 'corridor-1', settlement_rail: 'stripe', settlement_provider: 'stripe',
    };
    const paidOrder = { ...processingOrder, state: 'paid' as const, funding_state: 'finalized' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [processingOrder] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', provider: 'stripe', state: 'succeeded' }] })
      .mockResolvedValueOnce({ rows: [] }) // no other successful provider attempt
      .mockResolvedValueOnce({ rows: [{ debit_account: '512000', credit_account: '467100' }] })
      .mockResolvedValueOnce({ rows: [{ debit_account: '467100', credit_account: '708000' }] })
      .mockResolvedValueOnce({ rows: [paidOrder] })
      .mockResolvedValueOnce(undefined);

    await apiPaymentCheckoutService.markFinalAndDispatch('order-1', 'card', 'pi-verified');

    const [acquisition, fee] = accountingMocks.postTransaction.mock.calls.map(([command]) => command);
    expect(acquisition).toMatchObject({ transactionType: 'acquisition', metadata: { legalEntityId: 'legal-entity-1', beneficiaryType: 'NETWORK' } });
    expect(fee).toMatchObject({ transactionType: 'fee_collection', metadata: { legalEntityId: 'legal-entity-1', beneficiaryType: 'NETWORK' } });
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('FROM konektag.merchant_profiles'))).toBe(false);
    expect(webhookMocks.enqueuePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('uses the frozen MERCHANT party with the same Company context and merchant payment operation', async () => {
    const processingOrder = {
      ...pendingOrder, environment: 'live' as const, state: 'processing' as const,
      payment_method: 'card' as const, funding_state: 'external_started' as const,
      beneficiary_type: 'MERCHANT' as const, beneficiary_party_id: 'merchant-party-1',
      settlement_legal_entity_id: 'legal-entity-1', settlement_regulatory_profile_id: 'reg-profile-1',
      settlement_corridor_id: 'corridor-1', settlement_rail: 'stripe', settlement_provider: 'stripe',
    };
    const paidOrder = { ...processingOrder, state: 'paid' as const, funding_state: 'finalized' as const, version: 2 };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [processingOrder] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', provider: 'stripe', state: 'succeeded' }] })
      .mockResolvedValueOnce({ rows: [] }) // no other successful provider attempt
      .mockResolvedValueOnce({ rows: [{ id: 'sale-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [paidOrder] })
      .mockResolvedValueOnce(undefined);

    await apiPaymentCheckoutService.markFinalAndDispatch('order-1', 'card', 'pi-verified');

    const [payment] = accountingMocks.postTransaction.mock.calls.map(([command]) => command);
    expect(payment).toMatchObject({ transactionType: 'api_payment', metadata: { legalEntityId: 'legal-entity-1' } });
    expect(payment.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '2000', partyId: 'merchant-party-1', side: 'credit', amount: 10_500 }),
      expect.objectContaining({ accountCode: '3000', side: 'credit', amount: 315 }),
    ]));
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('FROM konektag.merchant_profiles'))).toBe(false);
    expect(webhookMocks.enqueuePaymentSucceeded).toHaveBeenCalledWith(expect.anything(), paidOrder);
  });

  it('fails closed for NETWORK when an operation guide is absent', async () => {
    const processingOrder = {
      ...pendingOrder, environment: 'live' as const, state: 'processing' as const,
      payment_method: 'card' as const, funding_state: 'external_started' as const,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [processingOrder] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', provider: 'stripe', state: 'succeeded' }] })
      .mockResolvedValueOnce({ rows: [] }) // no other successful provider attempt
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'NETWORK' }] })
      .mockResolvedValueOnce({ rows: [{ legalEntityId: 'legal-entity-1', regulatoryProfileId: 'reg-profile-1', corridorId: 'corridor-1', profile_count: '1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.markFinalAndDispatch('order-1', 'card', 'pi-verified'))
      .rejects.toBeInstanceOf(ApiPaymentNetworkOperationGuideRequiredError);
    expect(accountingMocks.postTransaction).not.toHaveBeenCalled();
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT INTO konektag.merchant_sales'))).toBe(false);
  });

  it('does not make Stripe funding depend on beneficiary type', async () => {
    const liveOrder = { ...pendingOrder, environment: 'live' as const };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [liveOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'NETWORK' }] })
      .mockResolvedValueOnce({ rows: [liveOrder] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.getStripeOrder('raw-token', undefined, false, { percentageBps: 300, fixedAmount: 0, currency: 'XOF' }))
      .resolves.toMatchObject({ id: 'order-1', externalAmount: 10_815 });
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('ledger_entries'))).toBe(false);
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes("funding_state = 'prepared'"))).toBe(true);
  });

  it('requires an approved wallet authorization before Mobile Money can start', async () => {
    const splitOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      funding_state: 'prepared' as const,
      wallet_amount: 7_000,
      external_amount: 3_815,
      payer_party_id: 'payer-party-1',
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [splitOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'payer-party-1' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [splitOrder] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.getMobileMoneyOrder('raw-token', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer', email: 'payer@example.test',
    }, { percentageBps: 300, fixedAmount: 0, currency: 'XOF' })).rejects.toMatchObject({ message: 'Wallet contribution requires an approved authorization' });

    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('api_payment_wallet_reservations r'))).toBe(true);
  });

  it('locks and persists an authenticated wallet/external split from party ledger entries', async () => {
    const liveOrder = { ...pendingOrder, environment: 'live' as const };
    const fundedOrder = {
      ...liveOrder,
      wallet_available_amount: 7_000,
      wallet_amount: 7_000,
      external_amount: 3_605, fee_amount: 105, total_amount: 10_605,
      payer_party_id: 'payer-party-1',
      funding_state: 'prepared' as const,
      version: 2,
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [liveOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'payer-party-1' }] })
      .mockResolvedValueOnce({ rows: [{ balance: '7000' }] })
      .mockResolvedValueOnce({ rows: [fundedOrder] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.prepareFunding('raw-token', {
      userId: 'user-1',
      keycloakId: '00000000-0000-0000-0000-000000000001',
      username: 'payer',
      email: 'payer@example.test',
    }, { percentageBps: 300, fixedAmount: 0, currency: 'XOF' })).resolves.toEqual({
      subtotalAmount: 10_000, taxAmount: 500, feeAmount: 105,
      totalAmount: 10_605,
      walletAvailable: 7_000,
      walletAmount: 7_000,
      externalAmount: 3_605,
      allowedPaymentMethods: ['card', 'mobile_money'],
    });
    expect(mocks.clientQuery.mock.calls[1][0]).toContain('FOR UPDATE');
    const balanceQuery = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes('points_balance'))!;
    const fundingUpdate = mocks.clientQuery.mock.calls.find((call: unknown[]) => String(call[0]).includes("funding_state = 'prepared'"))!;
    expect(balanceQuery[0]).toContain('points_balance');
    expect(fundingUpdate[1]).toEqual([7_000, 7_000, 3_605, 105, 10_605, 'payer-party-1', 'order-1', 1]);
  });

  it('builds one balanced accounting command using wallet and Stripe clearing', () => {
    const command = buildApiPaymentAccountingCommand({
      id: 'order-1',
      merchant_profile_id: 'merchant-1',
      merchant_transaction_id: 'merchant-tx-1',
      currency: 'XOF',
      total_amount: 10_815,
      fee_amount: 315,
      wallet_amount: 7_000,
      wallet_contribution_amount: 7_000,
      external_amount: 3_815,
      payer_party_id: 'payer-party-1',
    }, 'card', {
      merchantPartyId: 'merchant-party-1',
      legalEntityId: 'legal-entity-1',
      regulatoryProfileId: 'reg-profile-1',
      corridorId: 'corridor-1',
    });

    expect(command.idempotencyKey).toBe('api-payment-order-accounting:order-1');
    expect(command.metadata).toMatchObject({ merchantProfileId: 'merchant-1', paymentMethod: 'card', legalEntityId: 'legal-entity-1', regulatoryProfileId: 'reg-profile-1' });
    expect(command.entries).toEqual([
      expect.objectContaining({ accountCode: '1000', partyId: 'payer-party-1', side: 'debit', amount: 7_000 }),
      expect.objectContaining({ accountCode: '7000', side: 'debit', amount: 3_815 }),
      expect.objectContaining({ accountCode: '2000', partyId: 'merchant-party-1', side: 'credit', amount: 10_500 }),
      expect.objectContaining({ accountCode: '3000', side: 'credit', amount: 315 }),
    ]);
    expect(command.entries.filter((entry) => entry.side === 'debit').reduce((sum, entry) => sum + entry.amount, 0))
      .toBe(command.entries.filter((entry) => entry.side === 'credit').reduce((sum, entry) => sum + entry.amount, 0));
  });

  it('creates a 9,700 merchant debt, not a Merchant Wallet credit, for a 10,000 checkout with a 300 fee', () => {
    const command = buildApiPaymentAccountingCommand({
      id: 'order-10k', merchant_profile_id: 'merchant-1', merchant_transaction_id: 'merchant-tx-10k',
      currency: 'XOF', total_amount: 10_000, fee_amount: 300, wallet_amount: 0, wallet_contribution_amount: 0,
      external_amount: 10_000, payer_party_id: null,
    }, 'card', {
      merchantPartyId: 'merchant-party-1', legalEntityId: 'legal-entity-1',
      regulatoryProfileId: 'reg-profile-1', corridorId: null,
    });

    expect(command.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '7000', side: 'debit', amount: 10_000 }),
      expect.objectContaining({ accountCode: '3000', side: 'credit', amount: 300 }),
      expect.objectContaining({ accountCode: '2000', partyId: 'merchant-party-1', side: 'credit', amount: 9_700 }),
    ]));
    expect(command.entries.some(entry => entry.accountCode === '1100')).toBe(false);
  });

  it('builds NETWORK acquisition without account 2000 and preserves its operation guide', () => {
    const command = buildNetworkApiPaymentAccountingCommand({
      id: 'order-network', merchant_profile_id: 'network-1', merchant_transaction_id: 'network-tx',
      currency: 'EUR', total_amount: 1_000, fee_amount: 30, wallet_amount: 0,
      external_amount: 1_000, payer_party_id: null,
    }, 'card', {
      merchantPartyId: '', legalEntityId: 'legal-entity-1', regulatoryProfileId: 'reg-profile-1', corridorId: null,
    }, 'acquisition', { debitAccount: '512000', creditAccount: '467100' });

    expect(command.transactionType).toBe('acquisition');
    expect(command.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '7000', side: 'debit', amount: 1_000 }),
      expect.objectContaining({ accountCode: '8000', side: 'credit', amount: 1_000 }),
    ]));
    expect(command.entries.some(entry => entry.accountCode === '2000')).toBe(false);
    expect(command.metadata).toMatchObject({ beneficiaryType: 'NETWORK', accountingGuide: { debitAccount: '512000', creditAccount: '467100' } });
  });

  it('does not fake live card collection', async () => {
    const liveOrder = { ...pendingOrder, environment: 'live' as const };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [liveOrder] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.confirmCheckout('raw-token', 'card'))
      .rejects.toThrow('Stripe collection must be started by a dedicated endpoint');

    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('UPDATE konektag.api_payment_orders'))).toBe(false);
  });

  it('does not require an OTP or reservation for a card-only checkout', async () => {
    const cardOnly = { ...pendingOrder, environment: 'live' as const, funding_state: 'prepared' as const };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [cardOnly] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.getStripeOrder('raw-token')).resolves.toMatchObject({
      id: 'order-1', externalAmount: 10_815,
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it('blocks Stripe settlement when a Wallet contribution has no active reservation', async () => {
    const mixedOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      funding_state: 'prepared' as const,
      wallet_amount: 7_000,
      external_amount: 3_815,
      payer_party_id: 'payer-party-1',
    };
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [mixedOrder] })
      .mockResolvedValueOnce({ rows: [{ beneficiary_type: 'MERCHANT' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.attachStripePaymentIntent('raw-token', 'pi_123'))
      .rejects.toThrow('Wallet contribution requires an approved authorization');
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('api_payment_wallet_reservations'))).toBe(true);
  });

  it('fails closed instead of reserving Wallet funds when concurrent holds exhaust the balance', async () => {
    const mixedOrder = {
      ...pendingOrder,
      environment: 'live' as const,
      funding_state: 'prepared' as const,
      wallet_amount: 7_000,
      external_amount: 3_815,
      payer_party_id: 'payer-party-1',
    };
    walletAuthorizationMocks.verifyApiPayment.mockResolvedValue({
      lifecycle: 'approved', amount: 7_000, currency: 'K', payeeSnapshot: { displayName: 'Merchant' },
      expiresAt: '2026-07-24T00:05:00.000Z', approvedAt: '2026-07-24T00:01:00.000Z',
    });
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [mixedOrder] })
      .mockResolvedValueOnce({ rows: [{ id: 'payer-party-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ balance: 6_999 }] })
      .mockResolvedValueOnce(undefined);

    await expect(apiPaymentCheckoutService.verifyWalletAuthorization('raw-token', '123456', {
      userId: 'user-1', keycloakId: 'keycloak-1', username: 'payer', email: 'payer@example.test',
    })).rejects.toThrow('Wallet balance is no longer available for this checkout');
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('pg_advisory_xact_lock'))).toBe(true);
    expect(mocks.clientQuery.mock.calls.some((call: unknown[]) => String(call[0]).includes('INSERT INTO konektag.api_payment_wallet_reservations'))).toBe(false);
  });
});

describe('ERPNext Points K Mode of Payment freezes its provider', () => {
  const pointsKOrder = (provider: unknown, extra: Record<string, unknown> = {}) => ({
    ...pendingOrder, merchant_profile_id: null, order_purpose: 'wallet_recharge', business_purpose: 'wallet_recharge',
    environment: 'live' as const, amount_unit: 'MINOR', currency: 'XAF', subtotal_amount: 8_567, tax_amount: 0,
    fee_amount: 0, total_amount: 8_567, external_amount: 8_567, payment_country: 'CG',
    order_metadata: { erpnextPointsK: { paymentRequest: 'PR', modeOfPayment: provider === 'stripe' ? 'CB' : 'Mobile Money', provider } },
    ...extra,
  });
  const context = (provider: 'stripe' | 'pawapay') => ({
    currency: 'XAF', paymentCountry: 'CG', legalEntityId: 'le', regulatoryProfileId: 'profile', corridorId: 'corridor',
    regulatedActorId: 'actor', rail: provider === 'stripe' ? 'stripe' : 'mobile_money', provider,
    providerConfigurationKey: null, percentageBps: 0, fixedAmount: 0,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  });

  it('offers only the provider of the native mode on a prepared checkout', async () => {
    mocks.clientQuery.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [pointsKOrder('pawapay', { funding_state: 'prepared' })] })
      .mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.prepareFunding('raw-token')).resolves
      .toMatchObject({ amountUnit: 'MINOR', allowedPaymentMethods: ['mobile_money'] });
  });

  it.each([['pawapay', 'stripe'], ['stripe', 'pawapay']] as const)(
    'refuses a %s Points K order funded through a %s selection before any write', async (frozen, selected) => {
      mocks.clientQuery.mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [pointsKOrder(frozen)] })
        .mockResolvedValueOnce(undefined);
      await expect(apiPaymentCheckoutService.prepareFundingOrder('raw-token', undefined, context(selected)))
        .rejects.toThrow('does not match the ERPNext Points K Mode of Payment');
      expect(mocks.clientQuery.mock.calls.some(call => /UPDATE konektag/.test(String(call[0])))).toBe(false);
    });

  it('refuses a Stripe PaymentIntent for a Mobile Money Points K order', async () => {
    mocks.clientQuery.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [pointsKOrder('pawapay', { funding_state: 'prepared' })] })
      .mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.getStripeOrder('raw-token')).rejects.toThrow('does not match the ERPNext Points K Mode of Payment');
  });

  it('refuses Mobile Money confirmation for a CB Points K order', async () => {
    mocks.clientQuery.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [pointsKOrder('stripe', { funding_state: 'prepared' })] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [pointsKOrder('stripe', { funding_state: 'prepared' })] })
      .mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.confirmCheckout('raw-token', 'mobile_money')).rejects.toThrow('does not match the ERPNext Points K Mode of Payment');
    expect(mocks.clientQuery.mock.calls.some(call => /UPDATE konektag/.test(String(call[0])))).toBe(false);
  });

  it('refuses to fund an order whose native mode was never frozen', async () => {
    mocks.clientQuery.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [pointsKOrder(undefined)] })
      .mockResolvedValueOnce(undefined);
    await expect(apiPaymentCheckoutService.prepareFundingOrder('raw-token', undefined, context('pawapay')))
      .rejects.toThrow('has no frozen payment provider');
  });
});
