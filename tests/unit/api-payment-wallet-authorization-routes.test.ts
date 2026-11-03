import { beforeEach, describe, expect, it, vi } from 'vitest';

const checkoutMocks = vi.hoisted(() => ({
  issueWalletAuthorization: vi.fn(),
  verifyWalletAuthorization: vi.fn(),
}));

vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({
  apiPaymentCheckoutService: checkoutMocks,
  ApiPaymentConflictError: class ApiPaymentConflictError extends Error {},
  ApiPaymentNotFoundError: class ApiPaymentNotFoundError extends Error {},
  ApiPaymentValidationError: class ApiPaymentValidationError extends Error {},
}));
vi.mock('../../src/application/services/pay/wallet-debit-authorization-service.ts', () => ({
  WalletDebitAuthorizationError: class WalletDebitAuthorizationError extends Error {},
  WalletDebitAuthorizationDeliveryError: class WalletDebitAuthorizationDeliveryError extends Error {},
  WalletDebitAuthorizationNotFoundError: class WalletDebitAuthorizationNotFoundError extends Error {},
  WalletDebitAuthorizationRateLimitError: class WalletDebitAuthorizationRateLimitError extends Error {},
}));

import { POST as issue } from '../../src/api/routes/pay/checkout/[token]/wallet-authorization.ts';
import { POST as verify } from '../../src/api/routes/pay/checkout/[token]/wallet-authorization/verify.ts';

const user = { id: 'user-1', keycloak_id: 'keycloak-1', username: 'payer', email: 'payer@example.test' };
const url = 'https://app.example.test/api/pay/checkout/checkout-token/wallet-authorization';

describe('API checkout Wallet authorization routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('derives the Wallet amount server-side and rejects caller overrides', async () => {
    checkoutMocks.issueWalletAuthorization.mockResolvedValue({
      funding: { walletAvailable: 7_000, walletAmount: 7_000, externalAmount: 3_815 },
      authorization: { lifecycle: 'issued', amount: 7_000, currency: 'XOF', payeeName: 'Merchant', expiresAt: '2026-07-24T00:05:00.000Z', approvedAt: null },
      emailSent: true,
    });
    const accepted = await issue({
      request: new Request(url, { method: 'POST', headers: { Origin: 'https://app.example.test', 'Content-Type': 'application/json' }, body: '{}' }),
      params: { token: 'checkout-token' }, locals: { user },
    } as any);
    expect(accepted.status).toBe(201);
    expect(checkoutMocks.issueWalletAuthorization).toHaveBeenCalledWith('checkout-token', expect.objectContaining({ userId: 'user-1' }));

    const overridden = await issue({
      request: new Request(url, { method: 'POST', headers: { Origin: 'https://app.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 1, currency: 'EUR', operationId: 'attacker' }) }),
      params: { token: 'checkout-token' }, locals: { user },
    } as any);
    expect(overridden.status).toBe(422);
    expect(checkoutMocks.issueWalletAuthorization).toHaveBeenCalledTimes(1);
  });

  it('accepts only a six-digit OTP and returns no authorization identifier', async () => {
    checkoutMocks.verifyWalletAuthorization.mockResolvedValue({
      funding: { walletAvailable: 7_000, walletAmount: 7_000, externalAmount: 3_815 },
      authorization: { lifecycle: 'approved', amount: 7_000, currency: 'XOF', payeeName: 'Merchant', expiresAt: '2026-07-24T00:30:00.000Z', approvedAt: '2026-07-24T00:01:00.000Z' },
    });
    const invalid = await verify({
      request: new Request(url + '/verify', { method: 'POST', headers: { Origin: 'https://app.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ otp: '123456', amount: 1 }) }),
      params: { token: 'checkout-token' }, locals: { user },
    } as any);
    expect(invalid.status).toBe(422);

    const response = await verify({
      request: new Request(url + '/verify', { method: 'POST', headers: { Origin: 'https://app.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ otp: '123456' }) }),
      params: { token: 'checkout-token' }, locals: { user },
    } as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.not.objectContaining({ authorizationId: expect.anything() }));
    expect(checkoutMocks.verifyWalletAuthorization).toHaveBeenCalledWith('checkout-token', '123456', expect.objectContaining({ userId: 'user-1' }));
  });
});
