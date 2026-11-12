import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableIsolatedPawaPaySandbox } from '../helpers/pawapay-sandbox-runtime.ts';
beforeEach(enableIsolatedPawaPaySandbox);
afterEach(() => vi.unstubAllEnvs());
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
    getDeposit: vi.fn(async () => { calls.push('lookup'); throw new PawaPayError('PawaPay deposit NOT_FOUND'); }),
  };
  const checkout: any = {
    getMobileMoneyOrder: vi.fn(async () => ({ id: 'order-1', currency: 'XAF', externalAmount: 8567, paymentCountry: 'COG',
      providerConfigurationKey: 'KTG_CG_PAWAPAY_SANDBOX', amountUnit: 'MINOR', pointsK: true, ...overrides.order })),
    confirmCheckout: vi.fn(async () => { calls.push('confirm'); return { outcome: 'awaiting_mobile_money', order: { state: 'awaiting_mobile_money' } }; }),
    reopenAfterTerminalProviderAttempt: vi.fn(async () => { calls.push('reopen'); }),
  };
  const attempts: any = {
    createOrGetPawaPayDirectDepositAttempt: vi.fn(async () => { calls.push('attempt'); return { depositId: '00000000-0000-4000-8000-000000000009', created: true }; }),
    claimPawaPayDepositRequest: vi.fn(async () => { calls.push('claim'); return true; }),
    releasePawaPayDirectDepositAttempt: vi.fn(async () => { calls.push('release'); return true; }),
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
    expect(d.calls).toEqual(['predict', 'active-conf', 'attempt', 'confirm', 'claim', 'deposit', 'observed', 'recharge']);
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

  describe('failure compensation', () => {
    it('releases the attempt and reopens the checkout when the lock fails before any pawaPay call', async () => {
      const d = deps();
      d.checkout.confirmCheckout.mockImplementation(async () => { d.calls.push('confirm'); throw new Error('database unavailable'); });
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d)).rejects.toThrow('database unavailable');
      expect(d.calls.slice(-3)).toEqual(['confirm', 'release', 'reopen']);
      expect(d.attempts.releasePawaPayDirectDepositAttempt).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000009');
      expect(d.client.createDeposit).not.toHaveBeenCalled();
    });

    it('keeps the original error when reopening after a failed lock also fails', async () => {
      const d = deps();
      d.checkout.confirmCheckout.mockRejectedValue(new Error('lock failed'));
      d.checkout.reopenAfterTerminalProviderAttempt.mockRejectedValue(new Error('reopen failed'));
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d)).rejects.toThrow('lock failed');
    });

    it('does not reopen when a concurrent retry already sent the deposit (release refused)', async () => {
      const d = deps();
      d.checkout.confirmCheckout.mockRejectedValue(new Error('lock failed'));
      d.attempts.releasePawaPayDirectDepositAttempt.mockResolvedValue(false);
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d)).rejects.toThrow('lock failed');
      expect(d.checkout.reopenAfterTerminalProviderAttempt).not.toHaveBeenCalled();
    });

    it('releases the unused attempt when the checkout is already paid', async () => {
      const d = deps();
      d.checkout.confirmCheckout.mockResolvedValue({ outcome: 'paid', order: { state: 'paid' } });
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d)).resolves.toMatchObject({ outcome: 'paid' });
      expect(d.attempts.releasePawaPayDirectDepositAttempt).toHaveBeenCalled();
      expect(d.client.createDeposit).not.toHaveBeenCalled();
    });

    it('never contacts pawaPay when the attempt was released or expired before the request', async () => {
      const d = deps();
      d.attempts.claimPawaPayDepositRequest.mockResolvedValue(false);
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d)).rejects.toThrow('no longer active');
      expect(d.client.createDeposit).not.toHaveBeenCalled();
    });

    it('marks an HTTP 4xx refusal failed and reopens: no deposit exists at pawaPay', async () => {
      const d = deps();
      d.client.createDeposit.mockRejectedValue(new PawaPayError('PawaPay request failed (400)', 400, 'INVALID_PHONE_NUMBER'));
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d))
        .rejects.toMatchObject({ code: 'PAWAPAY_DEPOSIT_REJECTED', status: 422, detail: { failureCode: 'INVALID_PHONE_NUMBER' } });
      expect(d.attempts.markPawaPayDepositRejected).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000009', 'INVALID_PHONE_NUMBER');
      expect(d.checkout.reopenAfterTerminalProviderAttempt).toHaveBeenCalled();
      expect(d.attempts.releasePawaPayDirectDepositAttempt).not.toHaveBeenCalled();
    });

    it.each([
      ['a timeout', new TypeError('fetch failed')],
      ['a 5xx', new PawaPayError('PawaPay request failed (503)', 503)],
      ['an unreadable response', new PawaPayError('Invalid PawaPay deposit initiation response')],
    ])('keeps the attempt on %s when pawaPay does not know the deposit, for an idempotent retry', async (_, failure) => {
      const d = deps();
      d.client.createDeposit.mockRejectedValue(failure);
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d))
        .rejects.toMatchObject({ code: 'PAWAPAY_DEPOSIT_UNCONFIRMED', status: 502, detail: { depositId: '00000000-0000-4000-8000-000000000009' } });
      expect(d.client.getDeposit).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000009', 'KTG_CG_PAWAPAY_SANDBOX');
      expect(d.attempts.releasePawaPayDirectDepositAttempt).not.toHaveBeenCalled();
      expect(d.attempts.markPawaPayDepositRejected).not.toHaveBeenCalled();
      expect(d.checkout.reopenAfterTerminalProviderAttempt).not.toHaveBeenCalled();
    });

    it('treats an ambiguous failure as accepted when the read-only lookup finds the deposit', async () => {
      const d = deps();
      d.client.createDeposit.mockRejectedValue(new TypeError('fetch failed'));
      d.client.getDeposit.mockResolvedValue({ depositId: '00000000-0000-4000-8000-000000000009', status: 'ACCEPTED' });
      await expect(startPawaPayDirectDeposit('token', undefined, { phoneNumber: '242053456789' }, d))
        .resolves.toMatchObject({ outcome: 'awaiting_mobile_money', status: 'ACCEPTED' });
      expect(d.calls.slice(-2)).toEqual(['observed', 'recharge']);
    });
  });

  it('lists only operators that can collect this checkout amount', async () => {
    const d = deps({ providers: [mtn, { ...mtn, provider: 'AIRTEL_COG', status: 'CLOSED' }] });
    await expect(listPawaPayDepositProviders('token', undefined, d)).resolves.toEqual({ country: 'COG', currency: 'XAF', amount: '8567',
      providers: [{ provider: 'MTN_MOMO_COG', nameDisplayedToCustomer: 'MTN MoMo', minAmount: '100', maxAmount: '2000000', pinPrompt: 'AUTOMATIC', pinPromptRevivable: false }] });
  });
});
