import type { RouteHandler } from '../../../http';
import { PawaPayError, type PawaPayDeposit, verifyPawaPayWebhook } from '../../../../infrastructure/adapters/pawapay-client.ts';
import { pawaPayDepositService } from '../../../../application/services/pay/pawapay-deposit-service.ts';
import { paymentProviderAttemptService } from '../../../../application/services/pay/payment-provider-attempt-service.ts';

export const POST: RouteHandler = async ({ request }) => {
  const rawBody = await request.text();
  try { const deposit = JSON.parse(rawBody) as PawaPayDeposit; await verifyPawaPayWebhook(request, rawBody, await paymentProviderAttemptService.getPawaPayConfigurationKey(deposit.depositId)); await pawaPayDepositService.consume(deposit, rawBody); return Response.json({ received: true }); }
  catch (error) { return Response.json({ error: 'Invalid PawaPay callback' }, { status: error instanceof PawaPayError || error instanceof SyntaxError ? 400 : 500 }); }
};
