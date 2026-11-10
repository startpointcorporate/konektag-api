import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { connect: databaseMocks.connect, query: databaseMocks.query },
}));

import {
  PaymentProviderAttemptValidationError,
  paymentProviderAttemptService,
  stripeSafeCardDetails,
  validateProviderCardBin,
} from '../../src/application/services/pay/payment-provider-attempt-service.ts';

describe('paymentProviderAttemptService card minimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.connect.mockResolvedValue({ query: databaseMocks.clientQuery, release: databaseMocks.release });
  });
  it('persists only explicit safe Stripe card attributes and never derives digits', () => {
    const details = stripeSafeCardDetails({
      card: {
        country: 'FR',
        brand: 'visa',
        funding: 'credit',
        last4: '4242',
        fingerprint: 'sensitive-provider-fingerprint',
      },
    });

    expect(details).toEqual({ country: 'FR', brand: 'visa', funding: 'credit' });
    expect(details).not.toHaveProperty('last4');
    expect(details).not.toHaveProperty('fingerprint');
    expect(details).not.toHaveProperty('bin');
  });

  it('does not send last4 or other sensitive Stripe card fields to persistence', async () => {
    databaseMocks.query.mockResolvedValue({ rows: [{ id: 'attempt-1' }] });

    await paymentProviderAttemptService.createOrUpdateStripeApiCheckoutAttempt({
      orderId: 'order-1',
      paymentIntent: {
        id: 'pi_123', amount: 1_000, currency: 'eur', status: 'processing',
        payment_method_details: {
          card: { country: 'FR', brand: 'visa', funding: 'credit', last4: '4242', fingerprint: 'fp_secret' },
        },
      },
    });

    const persistedArguments = JSON.stringify(databaseMocks.query.mock.calls[0][1]);
    expect(persistedArguments).not.toContain('4242');
    expect(persistedArguments).not.toContain('fp_secret');
    expect(persistedArguments).toContain('visa');
  });

  it.each([
    ['requires_payment_method', 'pending'],
    ['requires_confirmation', 'pending'],
    ['requires_action', 'processing'],
    ['processing', 'processing'],
    ['succeeded', 'succeeded'],
    ['canceled', 'failed'],
  ] as const)('maps Stripe %s to the non-terminal or terminal attempt state %s', async (stripeStatus, expectedState) => {
    databaseMocks.query.mockResolvedValue({ rows: [{ id: 'attempt-1' }] });

    await paymentProviderAttemptService.createOrUpdateStripeApiCheckoutAttempt({
      orderId: 'order-1',
      paymentIntent: { id: 'pi_123', amount: 1_000, currency: 'eur', status: stripeStatus },
    });

    expect(databaseMocks.query.mock.calls[0][1][8]).toBe(expectedState);
  });

  it('accepts an explicit eight-digit provider BIN only', () => {
    expect(validateProviderCardBin('12345678')).toBe('12345678');
    expect(() => validateProviderCardBin('123456')).toThrow(PaymentProviderAttemptValidationError);
    expect(() => validateProviderCardBin('1234567x')).toThrow(PaymentProviderAttemptValidationError);
  });

  it('uses the provider reference as primary correlation and rejects mismatching optional metadata', async () => {
    databaseMocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 'provider-event-1', processed_at: null, failed_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', source_type: 'api_payment', source_id: 'order-1', operation_id: 'order-1', provider: 'stripe', provider_reference: 'pi_123', expected_amount: 1_000, expected_currency: 'EUR' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const result = await paymentProviderAttemptService.consumeStripeEvent({
      id: 'evt_metadata_mismatch',
      type: 'payment_intent.succeeded',
      payloadHash: 'a'.repeat(64),
      paymentIntent: {
        id: 'pi_123', amount: 1_000, currency: 'eur', status: 'succeeded',
        metadata: { konektag_source_type: 'api_payment', konektag_source_id: 'order-1', konektag_operation_id: 'other-order' },
      },
    });

    expect(result).toEqual({ outcome: 'rejected' });
    expect(databaseMocks.clientQuery.mock.calls[3][0]).toContain("error_code = 'metadata_mismatch'");
    expect(databaseMocks.release).toHaveBeenCalledOnce();
  });

  it('settles an attempt resolved only by its Stripe PaymentIntent reference', async () => {
    databaseMocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 'provider-event-1', processed_at: null, failed_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', source_type: 'api_payment', source_id: 'order-1', operation_id: 'order-1', provider: 'stripe', provider_reference: 'pi_123', expected_amount: 1_000, expected_currency: 'EUR' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] }) // not a Points K recharge: no Network operation
      .mockResolvedValueOnce(undefined);

    await expect(paymentProviderAttemptService.consumeStripeEvent({
      id: 'evt_provider_reference', type: 'payment_intent.succeeded', payloadHash: 'b'.repeat(64),
      paymentIntent: { id: 'pi_123', amount: 1_000, currency: 'eur', status: 'succeeded', metadata: {} },
    })).resolves.toEqual({ outcome: 'ready_to_settle', eventId: 'provider-event-1', sourceType: 'api_payment', sourceId: 'order-1' });
    expect(databaseMocks.clientQuery.mock.calls[2][0]).toContain('provider_reference = $1');
  });

  it('accepts the PostgreSQL string representation of a BIGINT expected amount', async () => {
    databaseMocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 'provider-event-1', processed_at: null, failed_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', source_type: 'api_payment', source_id: 'order-1', operation_id: 'order-1', provider: 'stripe', provider_reference: 'pi_123', expected_amount: '1000', expected_currency: 'EUR' }] })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] }) // not a Points K recharge: no Network operation
      .mockResolvedValueOnce(undefined);

    await expect(paymentProviderAttemptService.consumeStripeEvent({
      id: 'evt_bigint_amount', type: 'payment_intent.succeeded', payloadHash: 'c'.repeat(64),
      paymentIntent: { id: 'pi_123', amount: 1_000, currency: 'eur', status: 'succeeded', metadata: {} },
    })).resolves.toEqual({ outcome: 'ready_to_settle', eventId: 'provider-event-1', sourceType: 'api_payment', sourceId: 'order-1' });
  });
});
