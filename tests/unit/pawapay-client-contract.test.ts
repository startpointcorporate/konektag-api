import { afterEach, describe, expect, it, vi } from 'vitest';
import { pawaPayClient } from '../../src/infrastructure/adapters/pawapay-client.ts';

describe('PawaPay Payment Page contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a fixed XAF payment page without MSISDN or operator selection', async () => {
    process.env.PAWAPAY_API_URL = 'https://api.sandbox.pawapay.io';
    process.env.PAWAPAY_API_TOKEN = 'test-token';
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_URL = 'https://api.sandbox.pawapay.io';
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_TOKEN = 'test-token';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ redirectUrl: 'https://sandbox.paywith.pawapay.io/?token=session' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pawaPayClient.createPaymentPage({
      depositId: '00000000-0000-4000-8000-000000000001',
      returnUrl: 'https://www.konektag.eu/api/pay/checkout/token/mobile-money/pawapay/return',
      amount: 7000,
      currency: 'XAF',
      country: 'CMR',
      reason: 'Konektag payment',
      metadata: [{ paymentOrderId: 'order-1' }],
      providerConfigurationKey: 'KTG_CG_PAWAPAY_SANDBOX',
    })).resolves.toBe('https://sandbox.paywith.pawapay.io/?token=session');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sandbox.pawapay.io/v2/paymentpage');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      depositId: '00000000-0000-4000-8000-000000000001',
      returnUrl: 'https://www.konektag.eu/api/pay/checkout/token/mobile-money/pawapay/return',
      amountDetails: { amount: '7000', currency: 'XAF' },
      country: 'CMR',
      reason: 'Konektag payment',
      metadata: [{ paymentOrderId: 'order-1' }],
    });
  });
});

describe('PawaPay v2 direct deposit contract', () => {
  afterEach(() => vi.unstubAllGlobals());
  const key = 'KTG_CG_PAWAPAY_SANDBOX';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  function stub(...responses: Response[]) {
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_URL = 'https://api.sandbox.pawapay.io';
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_TOKEN = 'corridor-token';
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('predicts the provider with the v2 body on the corridor account', async () => {
    const fetchMock = stub(json({ country: 'COG', provider: 'MTN_MOMO_COG', phoneNumber: '242053456789' }));
    await expect(pawaPayClient.predictProvider('+242 05 345 6789', key))
      .resolves.toEqual({ country: 'COG', provider: 'MTN_MOMO_COG', phoneNumber: '242053456789' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sandbox.pawapay.io/v2/predict-provider');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer corridor-token');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ phoneNumber: '+242 05 345 6789' });
  });

  it('keeps the pawaPay failure code of an invalid phone number', async () => {
    stub(json({ failureReason: { failureCode: 'INVALID_INPUT', failureMessage: 'bad' } }, 400));
    await expect(pawaPayClient.predictProvider('12', key)).rejects.toMatchObject({ status: 400, failureCode: 'INVALID_INPUT' });
  });

  it('initiates an MMO deposit with accountDetails and a major decimal amount', async () => {
    const depositId = '00000000-0000-4000-8000-000000000002';
    const fetchMock = stub(json({ depositId, status: 'ACCEPTED', created: '2026-11-11T10:00:00Z' }));
    await expect(pawaPayClient.createDeposit({ depositId, phoneNumber: '242053456789', provider: 'MTN_MOMO_COG',
      amount: '8567', currency: 'XAF', customerMessage: 'Konektag Points K', clientReferenceId: 'order-1',
      metadata: [{ paymentOrderId: 'order-1' }], providerConfigurationKey: key })).resolves.toEqual({ status: 'ACCEPTED' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sandbox.pawapay.io/v2/deposits');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      depositId,
      payer: { type: 'MMO', accountDetails: { phoneNumber: '242053456789', provider: 'MTN_MOMO_COG' } },
      amount: '8567', currency: 'XAF', clientReferenceId: 'order-1', customerMessage: 'Konektag Points K',
      metadata: [{ paymentOrderId: 'order-1' }],
    });
  });

  it('returns REJECTED with its failure code and refuses unknown statuses', async () => {
    const depositId = '00000000-0000-4000-8000-000000000003';
    const input = { depositId, phoneNumber: '242053456789', provider: 'MTN_MOMO_COG', amount: '8567', currency: 'XAF',
      customerMessage: 'Konektag Points K', clientReferenceId: 'order-1', metadata: [], providerConfigurationKey: key };
    stub(json({ depositId, status: 'REJECTED', failureReason: { failureCode: 'INVALID_AMOUNT', failureMessage: 'limit' } }),
      json({ depositId, status: 'COMPLETED' }));
    await expect(pawaPayClient.createDeposit(input)).resolves.toEqual({ status: 'REJECTED', failureCode: 'INVALID_AMOUNT', failureMessage: 'limit' });
    await expect(pawaPayClient.createDeposit(input)).rejects.toThrow('Invalid PawaPay deposit initiation response');
  });

  it('validates the request before any network call', async () => {
    const fetchMock = stub();
    for (const bad of [{ depositId: 'not-a-uuid' }, { amount: '0' }, { amount: '-1' }, { amount: '1.23456' }, { customerMessage: 'Konektag: Points K!' }, { phoneNumber: '+242 05' }]) {
      await expect(pawaPayClient.createDeposit({ depositId: '00000000-0000-4000-8000-000000000004', phoneNumber: '242053456789',
        provider: 'MTN_MOMO_COG', amount: '8567', currency: 'XAF', customerMessage: 'Konektag Points K', clientReferenceId: 'o',
        metadata: [], providerConfigurationKey: key, ...bad })).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads DEPOSIT operators of one country and currency from active-conf', async () => {
    const fetchMock = stub(json({ companyName: 'Konektag', countries: [{ country: 'COG', providers: [
      { provider: 'MTN_MOMO_COG', nameDisplayedToCustomer: 'MTN MoMo', currencies: [
        { currency: 'XAF', operationTypes: { DEPOSIT: { minAmount: '100', maxAmount: '2000000', decimalsInAmount: 'NONE',
          status: 'OPERATIONAL', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC', pinPromptRevivable: false } } }] },
      { provider: 'AIRTEL_COG', currencies: [{ currency: 'XAF', operationTypes: { PAYOUT: { status: 'OPERATIONAL' } } }] },
    ] }] }));
    await expect(pawaPayClient.depositProviders('COG', 'XAF', key)).resolves.toEqual([{
      provider: 'MTN_MOMO_COG', nameDisplayedToCustomer: 'MTN MoMo', currency: 'XAF', status: 'OPERATIONAL',
      minAmount: '100', maxAmount: '2000000', decimalsInAmount: 'NONE', authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC', pinPromptRevivable: false,
    }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sandbox.pawapay.io/v2/active-conf?country=COG&operationType=DEPOSIT');
  });

  it('reads the limits under the minTransactionLimit/maxTransactionLimit names of the documented example', async () => {
    stub(json({ companyName: 'Konektag', countries: [{ country: 'COG', providers: [
      { provider: 'MTN_MOMO_COG', currencies: [{ currency: 'XAF', operationTypes: { DEPOSIT: { authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC',
        pinPromptRevivable: true, minTransactionLimit: '1', maxTransactionLimit: '1000', decimalsInAmount: 'NONE', status: 'OPERATIONAL' } } }] },
    ] }] }));
    const [provider] = await pawaPayClient.depositProviders('COG', 'XAF', key);
    expect(provider).toMatchObject({ minAmount: '1', maxAmount: '1000', status: 'OPERATIONAL', decimalsInAmount: 'NONE' });
  });
});
