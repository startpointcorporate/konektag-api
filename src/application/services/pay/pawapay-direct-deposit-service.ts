/**
 * Points K Mobile Money collected inside Konektag through a pawaPay v2 direct deposit.
 * The payer approves on their phone with the operator PIN; Konektag never sees it.
 * The amount is the frozen API order (ERPNext Payment Request), never a browser value,
 * and the final status comes only from the signed pawaPay callback or reconciliation.
 * Other consumers keep the Payment Page flow.
 */
import { createHash } from 'node:crypto';
import { pawaPayClient, PawaPayError, type PawaPayDepositProvider } from '../../../infrastructure/adapters/pawapay-client.ts';
import { apiPaymentCheckoutService, ApiPaymentConflictError, type ApiPaymentMobileMoneyOrder, type ApiPaymentPayer } from './api-payment-checkout-service.ts';
import { PaymentProviderAttemptConflictError, paymentProviderAttemptService } from './payment-provider-attempt-service.ts';
import { minorDecimal } from './money-unit.ts';

export class PawaPayDirectDepositError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail: Record<string, unknown> = {}) { super(code); }
}

type Deps = { client?: typeof pawaPayClient; checkout?: typeof apiPaymentCheckoutService; attempts?: typeof paymentProviderAttemptService };

const CUSTOMER_MESSAGE = 'Konektag Points K';

function providerAmount(order: ApiPaymentMobileMoneyOrder): string {
  return order.amountUnit === 'MINOR' ? minorDecimal(order.externalAmount, order.currency) : String(order.externalAmount);
}

/** Only an operator that is OPERATIONAL, authorised by the operator PIN and within its limits can be offered. */
function eligible(provider: PawaPayDepositProvider, amount: string): string | null {
  if (provider.status !== 'OPERATIONAL') return 'PAWAPAY_PROVIDER_UNAVAILABLE';
  if (provider.authType !== 'PROVIDER_AUTH') return 'PAWAPAY_PROVIDER_AUTH_UNSUPPORTED';
  if (provider.decimalsInAmount === 'NONE' && amount.includes('.')) return 'PAWAPAY_AMOUNT_PRECISION_UNSUPPORTED';
  if (provider.minAmount !== null && Number(amount) < Number(provider.minAmount)) return 'PAWAPAY_AMOUNT_BELOW_MINIMUM';
  if (provider.maxAmount !== null && Number(amount) > Number(provider.maxAmount)) return 'PAWAPAY_AMOUNT_ABOVE_MAXIMUM';
  return null;
}

const publicProvider = (provider: PawaPayDepositProvider) => ({
  provider: provider.provider, nameDisplayedToCustomer: provider.nameDisplayedToCustomer,
  minAmount: provider.minAmount, maxAmount: provider.maxAmount,
  pinPrompt: provider.pinPrompt, pinPromptRevivable: provider.pinPromptRevivable,
});

async function pointsKOrder(token: string, payer: ApiPaymentPayer | undefined, deps: Deps) {
  const order = await (deps.checkout ?? apiPaymentCheckoutService).getMobileMoneyOrder(token, payer);
  if (!order.pointsK) throw new PawaPayDirectDepositError('PAWAPAY_DIRECT_DEPOSIT_NOT_AVAILABLE', 409);
  return order;
}

export async function listPawaPayDepositProviders(token: string, payer: ApiPaymentPayer | undefined, deps: Deps = {}) {
  const order = await pointsKOrder(token, payer, deps);
  const amount = providerAmount(order);
  const providers = await (deps.client ?? pawaPayClient).depositProviders(order.paymentCountry, order.currency, order.providerConfigurationKey);
  return {
    country: order.paymentCountry, currency: order.currency, amount,
    providers: providers.filter(provider => !eligible(provider, amount)).map(publicProvider),
  };
}

export async function startPawaPayDirectDeposit(
  token: string, payer: ApiPaymentPayer | undefined, input: { phoneNumber: string; provider?: string }, deps: Deps = {},
) {
  const client = deps.client ?? pawaPayClient;
  const checkout = deps.checkout ?? apiPaymentCheckoutService;
  const attempts = deps.attempts ?? paymentProviderAttemptService;
  const order = await pointsKOrder(token, payer, deps);
  const amount = providerAmount(order);

  let prediction: Awaited<ReturnType<typeof client.predictProvider>>;
  try { prediction = await client.predictProvider(input.phoneNumber, order.providerConfigurationKey); }
  catch (error) {
    if (error instanceof PawaPayError && error.status === 400) throw new PawaPayDirectDepositError('PHONE_NUMBER_INVALID', 400);
    throw error;
  }
  if (prediction.country !== order.paymentCountry) throw new PawaPayDirectDepositError('PHONE_NUMBER_COUNTRY_MISMATCH', 409);
  if (input.provider && input.provider !== prediction.provider) {
    throw new PawaPayDirectDepositError('PAWAPAY_PROVIDER_MISMATCH', 409, { predictedProvider: prediction.provider });
  }
  const providers = await client.depositProviders(order.paymentCountry, order.currency, order.providerConfigurationKey);
  const provider = providers.find(row => row.provider === prediction.provider);
  if (!provider) throw new PawaPayDirectDepositError('PAWAPAY_PROVIDER_NOT_CONFIGURED', 409);
  const refusal = eligible(provider, amount);
  if (refusal) throw new PawaPayDirectDepositError(refusal, 409);

  const phoneNumberHash = createHash('sha256').update(prediction.phoneNumber).digest('hex');
  let attempt: { depositId: string; created: boolean };
  try {
    attempt = await attempts.createOrGetPawaPayDirectDepositAttempt({ orderId: order.id, amount: order.externalAmount,
      currency: order.currency, providerConfigurationKey: order.providerConfigurationKey, provider: provider.provider, phoneNumberHash });
  } catch (error) {
    if (error instanceof PaymentProviderAttemptConflictError) throw new ApiPaymentConflictError(error.message);
    throw error;
  }
  // Lock the checkout on Mobile Money before the operator prompt is requested.
  const confirmed = await checkout.confirmCheckout(token, 'mobile_money', payer);
  if (confirmed.outcome === 'paid') return { outcome: 'paid' as const, depositId: attempt.depositId, state: confirmed.order.state };

  const result = await client.createDeposit({
    depositId: attempt.depositId, phoneNumber: prediction.phoneNumber, provider: provider.provider,
    amount, currency: order.currency, customerMessage: CUSTOMER_MESSAGE, clientReferenceId: order.id,
    metadata: [{ paymentOrderId: order.id }], providerConfigurationKey: order.providerConfigurationKey,
  });
  if (result.status === 'REJECTED') {
    await attempts.markPawaPayDepositRejected(attempt.depositId, result.failureCode);
    await checkout.reopenAfterTerminalProviderAttempt(token);
    throw new PawaPayDirectDepositError('PAWAPAY_DEPOSIT_REJECTED', 422, { failureCode: result.failureCode });
  }
  // The deposit exists at pawaPay: keep the attempt until its callback or reconciliation.
  await attempts.markPawaPayDepositObserved(attempt.depositId);
  await attempts.recordRechargeAccepted('pawapay', attempt.depositId);
  return {
    outcome: 'awaiting_mobile_money' as const, depositId: attempt.depositId, status: result.status,
    state: confirmed.order.state, provider: publicProvider(provider),
  };
}
