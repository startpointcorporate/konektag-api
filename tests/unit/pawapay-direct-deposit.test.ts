import { describe, expect, it, vi } from 'vitest';
// Unit isolation: the database-backed services are injected; no pawaPay call is made.
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: {} }));
import { listPawaPayDepositProviders, startPawaPayDirectDeposit } from '../../src/application/services/pay/pawapay-direct-deposit-service.ts';
import { PawaPayError } from '../../src/infrastructure/adapters/pawapay-client.ts';
import { PaymentProviderAttemptConflictError } from '../../src/application/services/pay/payment-provider-attempt-service.ts';

const mtn = { provider: 'MTN_MOMO_COG', nameDisplayedToCustomer: 'MTN MoMo', currency: 'XAF', status: 'OPERATIONAL',
  minAmount: '100', maxAmount: '2000000', decimalsInAmount: 'NONE' as const, authType: 'PROVIDER_AUTH', pinPrompt: 'AUTOMATIC', pinPromptRevivable: false };

function deps(overrides: { order?: any; providers?: any[]; deposit?: any; prediction?: any } = {}) {
  const calls: string[] = [];
  const client: any = {
    predictProvider: vi.fn(async () => { calls.push('predict'); return overrides.prediction ?? { country: 'COG', provider: 'MTN_MOMO_COG', phoneNumber: '242053456789' }; }),
    depositProviders: vi.fn(async () => { calls.push('active-conf'); return overrides.providers ?? [mtn]; }),
    createDeposit: vi.fn(async () => { calls.push('deposit'); return overrides.deposit ?? { status: 'ACCEPTED' }; }),
  };
  const checkout: any = {
    getMobileMoneyOrder: vi.fn(async () => ({ id: 'order-1', currency: 'XAF', externalAmount: 8567, paymentCountry: 'COG',
      providerConfigurationKey: 'KTG_CG_PAWAPAY_SANDBOX', amountUnit: 'MINOR', pointsK: true, ...overrides.order })),
    confirmCheckout: vi.fn(async () => { calls.push('confirm'); return { outcome: 'awaiting_mobile_money', order: { state: 'awaiting_mobile_money' } }; }),
    reopenAfterTerminalProviderAttempt: vi.fn(async () => { calls.push('reopen'); }),
  };
  const attempts: any = {
    createOrGetPawaPayDirectDepositAttempt: vi.fn(async () => { calls.push('attempt'); return { depositId: '00000000-0000-4000-8000-000000000009', created: true }; }),
    markPawaPayDepositRejected: vi.fn(async () => { calls.push('rejected'); }),
    markPawaPayDepositObserved: vi.fn(async () => { calls.push('observed'); }),
    recordRechargeAccepted: vi.fn(async () => { calls.push('recharge'); }),
  };
  return { calls, client, checkout, attempts };
}

describe('Points K pawaPay v2 direct deposit', () => {
  it('locks the checkout, then sends the frozen ERPNext amount to the predicted operator', async () => {
    const d = deps();
    const result = await startPawaPayDirectDeposit('token', undefined, { phoneNumber: '+242 05 345 6789' }, d);
    expect(d.calls).toEqual(['predict', 'active-conf', 'attempt', 'confirm', 'deposit', 'observed', 'recharge']);
    expect(d.client.predictProvider).toHaveBeenCalledWith('+242 05 345 6789', 'KTG_CG_PAWAPAY_SANDBOX');
    expect(d.client.depositProviders).toHaveBeenCalledWith('COG', 'XAF', 'KTG_CG_PAWAPAY_SANDBOX');
    expect(d.client.createDeposit).toHaveBeenCalledWith({ depositId: '00000000-0000-4000-8000-000000000009',
      phoneNumber: '242053456789', provider: 'MTN_MOMO_COG', amount: '8567', currency: 'XAF', customerMessage: 'Konektag Points K',
      clientReferenceId: 'order-1', metadata: [{ paymentOrderId: 'order-1' }], providerConfigurationKey: 'KTG_CG_PAWAPAY_SANDBOX' });
    expect(d.attempts.createOrGetPawaPayDirectDepositAttempt).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1', amount: 8567, currency: 'XAF', provider: 'MTN_MOMO_COG', phoneNumberHash: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    expect(JSON.stringify(d.attempts.createOrGetPawaPayDirectDepositAttempt.mock.calls)).not.toContain('242053456789');
    expect(result).toMatchObject({ outcome: 'awaiting_mobile_money', status: 'ACCEPTED', provider: { provider: 'MTN_MOMO_COG', pinPrompt: 'AUTOMATIC' } });
  });

  it('converts a two-decimal MINOR order to the v2 major decimal string', async () => {
    const d = deps({ order: { currency: 'USD', externalAmount: 1221 }, providers: [{ ...mtn, decimalsInAmount: 'TWO_PLACES', minAmount: '1' }] });
    await startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d);
    expect(d.client.createDeposit.mock.calls[0][0]).toMatchObject({ amount: '12.21', currency: 'USD' });
  });

  it('refuses a fractional amount on an operator configured without decimals', async () => {
    const d = deps({ order: { currency: 'USD', externalAmount: 1221 }, providers: [{ ...mtn, minAmount: '1' }] });
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d))
      .rejects.toMatchObject({ code: 'PAWAPAY_AMOUNT_PRECISION_UNSUPPORTED' });
    expect(d.client.createDeposit).not.toHaveBeenCalled();
  });

  it('is reserved to Points K: other consumers keep the Payment Page', async () => {
    const d = deps({ order: { pointsK: false } });
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d))
      .rejects.toMatchObject({ code: 'PAWAPAY_DIRECT_DEPOSIT_NOT_AVAILABLE', status: 409 });
    expect(d.calls).toEqual([]);
  });

  it.each([
    ['another country', { prediction: { country: 'CMR', provider: 'MTN_MOMO_CMR', phoneNumber: '237653456789' } }, 'PHONE_NUMBER_COUNTRY_MISMATCH'],
    ['an operator absent from active-conf', { providers: [] }, 'PAWAPAY_PROVIDER_NOT_CONFIGURED'],
    ['a closed operator', { providers: [{ ...mtn, status: 'CLOSED' }] }, 'PAWAPAY_PROVIDER_UNAVAILABLE'],
    ['a pre-authorised operator', { providers: [{ ...mtn, authType: 'PREAUTH' }] }, 'PAWAPAY_PROVIDER_AUTH_UNSUPPORTED'],
    ['an amount below the operator minimum', { providers: [{ ...mtn, minAmount: '10000' }] }, 'PAWAPAY_AMOUNT_BELOW_MINIMUM'],
    ['an amount above the operator maximum', { providers: [{ ...mtn, maxAmount: '5000' }] }, 'PAWAPAY_AMOUNT_ABOVE_MAXIMUM'],
  ])('refuses %s before any attempt or deposit', async (_, overrides, code) => {
    const d = deps(overrides as any);
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d)).rejects.toMatchObject({ code });
    expect(d.calls).not.toContain('attempt');
    expect(d.calls).not.toContain('deposit');
  });

  it('refuses an operator chosen by the payer that differs from the prediction', async () => {
    const d = deps();
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789', provider: 'AIRTEL_COG' }, d))
      .rejects.toMatchObject({ code: 'PAWAPAY_PROVIDER_MISMATCH', detail: { predictedProvider: 'MTN_MOMO_COG' } });
  });

  it('maps an invalid phone number to a 400', async () => {
    const d = deps();
    d.client.predictProvider.mockRejectedValue(new PawaPayError('bad', 400, 'INVALID_INPUT'));
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '1234567' }, d)).rejects.toMatchObject({ code: 'PHONE_NUMBER_INVALID', status: 400 });
  });

  it('refuses a second phone or operator while an attempt is active', async () => {
    const d = deps();
    d.attempts.createOrGetPawaPayDirectDepositAttempt.mockRejectedValue(new PaymentProviderAttemptConflictError('A payment attempt is still active'));
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d)).rejects.toThrow('A payment attempt is still active');
    expect(d.client.createDeposit).not.toHaveBeenCalled();
  });

  it('marks a synchronously REJECTED deposit failed and reopens the checkout', async () => {
    const d = deps({ deposit: { status: 'REJECTED', failureCode: 'INVALID_AMOUNT', failureMessage: 'limit' } });
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d))
      .rejects.toMatchObject({ code: 'PAWAPAY_DEPOSIT_REJECTED', status: 422, detail: { failureCode: 'INVALID_AMOUNT' } });
    expect(d.calls.slice(-2)).toEqual(['rejected', 'reopen']);
    expect(d.attempts.recordRechargeAccepted).not.toHaveBeenCalled();
  });

  it('keeps a retried deposit idempotent on pawaPay with DUPLICATE_IGNORED', async () => {
    const d = deps({ deposit: { status: 'DUPLICATE_IGNORED' } });
    await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d))
      .resolves.toMatchObject({ outcome: 'awaiting_mobile_money', status: 'DUPLICATE_IGNORED' });
  });

  it('lists only operators that can collect this checkout amount', async () => {
    const d = deps({ providers: [mtn, { ...mtn, provider: 'AIRTEL_COG', status: 'CLOSED' }] });
    await expect(listPawaPayDepositProviders('token', undefined, d)).resolves.toEqual({ country: 'COG', currency: 'XAF', amount: '8567',
      providers: [{ provider: 'MTN_MOMO_COG', nameDisplayedToCustomer: 'MTN MoMo', minAmount: '100', maxAmount: '2000000', pinPrompt: 'AUTOMATIC', pinPromptRevivable: false }] });
  });
});
