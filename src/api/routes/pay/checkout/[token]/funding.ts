import type { RouteHandler } from '../../../../http';
import {
  apiPaymentCheckoutService,
  ApiPaymentConflictError,
  ApiPaymentNotFoundError,
  ApiPaymentValidationError,
  type ApiPaymentFundingSelection,
} from '../../../../../application/services/pay/api-payment-checkout-service.ts';

export const POST: RouteHandler = async ({ params, locals, request }) => {
  try {
    const body = await request.json() as {
      selectionToken?: unknown;
      useWalletPoints?: unknown;
      walletPointsAmount?: unknown;
    };
    const selectionToken = typeof body.selectionToken === 'string' && body.selectionToken ? body.selectionToken : undefined;
    if (!selectionToken && body.useWalletPoints !== true) {
      throw new ApiPaymentValidationError('selectionToken is required for card or mobile money funding');
    }
    if (body.useWalletPoints !== undefined && typeof body.useWalletPoints !== 'boolean') {
      throw new ApiPaymentValidationError('useWalletPoints must be a boolean');
    }
    if (body.walletPointsAmount !== undefined && (typeof body.walletPointsAmount !== 'number' || !Number.isSafeInteger(body.walletPointsAmount) || body.walletPointsAmount < 0)) {
      throw new ApiPaymentValidationError('walletPointsAmount must be a non-negative integer');
    }
    const payer = locals.user && {
      userId: locals.user.id,
      keycloakId: locals.user.keycloak_id,
      username: locals.user.username,
      email: locals.user.email,
    };
    const options: { useWalletPoints?: boolean; walletPointsAmount?: number } = {};
    if (body.useWalletPoints !== undefined) options.useWalletPoints = body.useWalletPoints as boolean;
    if (body.walletPointsAmount !== undefined) options.walletPointsAmount = body.walletPointsAmount as number;

    const funding = selectionToken
      ? await apiPaymentCheckoutService.prepareSelectedFunding(
          params.token || '', payer, selectionToken as ApiPaymentFundingSelection, options)
      : await apiPaymentCheckoutService.preparePointsFunding(params.token || '', payer, options);
    return new Response(JSON.stringify(funding), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const status = error instanceof ApiPaymentNotFoundError ? 404
      : error instanceof ApiPaymentValidationError ? 400
        : error instanceof ApiPaymentConflictError ? 422 : 500;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to prepare checkout funding' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
