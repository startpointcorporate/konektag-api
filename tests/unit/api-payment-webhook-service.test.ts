import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  httpsRequest: vi.fn(),
  resolveSubscription: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.poolQuery },
}));

vi.mock('node:https', () => ({ request: mocks.httpsRequest }));
vi.mock('../../src/application/services/merchant-pro-subscription-service.ts', () => ({
  MerchantProSubscriptionService: class { resolveSubscription = mocks.resolveSubscription; },
}));

import {
  apiPaymentWebhookService,
  ApiPaymentWebhookValidationError,
  resolveWebhookTarget,
  validateWebhookUrl,
} from '../../src/application/services/pay/api-payment-webhook-service.ts';

function mockHttpsResponse(status = 204, body = '') {
  mocks.httpsRequest.mockImplementationOnce((_options: unknown, callback: (response: EventEmitter & { statusCode?: number }) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
    outgoing.end = () => {
      const incoming = new EventEmitter() as EventEmitter & { statusCode?: number };
      incoming.statusCode = status;
      callback(incoming);
      incoming.emit('data', Buffer.from(body));
      incoming.emit('end');
    };
    outgoing.destroy = (error) => outgoing.emit('error', error);
    return outgoing;
  });
}

describe('apiPaymentWebhookService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSubscription.mockResolvedValue({ state: 'ACTIVE' });
    mockHttpsResponse();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the exact payment.succeeded payload and HMAC for a journaled delivery', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'endpoint-1', environment: 'sandbox', webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1', endpoint_id: 'endpoint-1', merchant_profile_id: 'merchant-1', event_type: 'payment.succeeded', attempts: 1, webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret', payload: {
        transactionId: 'merchant-tx-1', transactionDate: '2026-07-24T01:00:00.000Z', paymentId: 'payment-1', paymentAmount: 10_815, paymentFees: 315, currency: 'EUR', event: 'payment.succeeded', environment: 'sandbox',
      } }] })
      .mockResolvedValueOnce({ rows: [] });
    await apiPaymentWebhookService.enqueueAndDeliverPaymentSucceeded({
      id: 'payment-1', merchant_profile_id: 'merchant-1', environment: 'sandbox',
      merchant_transaction_id: 'merchant-tx-1', total_amount: 10_815, fee_amount: 315,
      currency: 'EUR', paid_at: '2026-07-24T01:00:00.000Z',
    });

    const expectedPayload = {
      transactionId: 'merchant-tx-1', transactionDate: '2026-07-24T01:00:00.000Z',
      paymentId: 'payment-1', paymentAmount: 10_815, paymentFees: 315,
      currency: 'EUR', event: 'payment.succeeded', environment: 'sandbox',
    };
    const rawPayload = JSON.stringify(expectedPayload);
    expect(mocks.httpsRequest).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '8.8.8.8',
      path: '/webhooks',
      headers: expect.objectContaining({
        'X-Konektag-Event': 'payment.succeeded',
        'X-Konektag-Signature': createHmac('sha256', 'signing-secret').update(rawPayload).digest('hex'),
      }),
    }), expect.any(Function));
    const options = mocks.httpsRequest.mock.calls[0][0];
    await expect(new Promise<void>((resolve, reject) => options.lookup('ignored', {}, (error: Error | null, address: string, family: number) => {
      try {
        expect(error).toBeNull();
        expect(address).toBe('8.8.8.8');
        expect(family).toBe(4);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    }))).resolves.toBeUndefined();
    expect(mocks.poolQuery.mock.calls[1][1]).toEqual(expect.arrayContaining([JSON.stringify(expectedPayload)]));
  });

  it('does not enqueue a merchant webhook after Pro expiration', async () => {
    mocks.resolveSubscription.mockResolvedValueOnce({ state: 'EXPIRED' });
    const result = await apiPaymentWebhookService.enqueuePaymentSucceeded({ query: mocks.poolQuery } as any, {
      id: 'payment-expired', merchant_profile_id: 'merchant-expired', environment: 'live',
      merchant_transaction_id: 'tx-expired', total_amount: 100, fee_amount: 0, currency: 'EUR', paid_at: new Date(),
    });
    expect(result).toBeNull();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('dead-letters a queued delivery whose merchant lost Pro before delivery', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'queued', endpoint_id: 'endpoint-1',
      merchant_profile_id: 'merchant-expired', event_type: 'payment.succeeded', attempts: 1,
      processing_lease_id: 'lease-1', webhook_url: 'https://8.8.8.8/webhooks',
      signing_secret: 'secret', payload: {} }] }).mockResolvedValueOnce({ rows: [] });
    mocks.resolveSubscription.mockResolvedValueOnce({ state: 'EXPIRED' });
    await apiPaymentWebhookService.deliverPaymentSucceeded('queued');
    expect(mocks.poolQuery.mock.calls.at(-1)?.[0]).toContain("status='dead_lettered'");
    expect(mocks.poolQuery.mock.calls.at(-1)?.[1]).toEqual(['queued', 'lease-1']);
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('dead-letters an expired merchant delivery claimed by processDue', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'queued', endpoint_id: 'endpoint-other',
        merchant_profile_id: 'merchant-other', event_type: 'payment.succeeded', attempts: 2,
        processing_lease_id: 'lease-2', webhook_url: 'https://8.8.8.8/webhooks',
        signing_secret: 'secret', payload: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.resolveSubscription.mockResolvedValueOnce({ state: 'EXPIRED' });
    await apiPaymentWebhookService.processDue();
    expect(mocks.resolveSubscription).toHaveBeenCalledWith('merchant-other');
    expect(mocks.poolQuery.mock.calls[1][0]).toContain('AS merchant_profile_id');
    expect(mocks.poolQuery.mock.calls[2][0]).toContain('PRO_SUBSCRIPTION_INACTIVE');
    expect(mocks.poolQuery.mock.calls[2][1]).toEqual(['queued', 'lease-2']);
    expect(mocks.httpsRequest).not.toHaveBeenCalled();
  });

  it('keeps a scheduled cancellation deliverable until its paid end', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'queued', endpoint_id: 'endpoint-1',
      merchant_profile_id: 'merchant-active', event_type: 'payment.succeeded', attempts: 1,
      processing_lease_id: 'lease-1', webhook_url: 'https://8.8.8.8/webhooks',
      signing_secret: 'secret', payload: {} }] }).mockResolvedValueOnce({ rows: [] });
    mocks.resolveSubscription.mockResolvedValueOnce({ state: 'ACTIVE',
      subscription: { cancelled_at: new Date(), subscription_end: new Date(Date.now() + 86_400_000) } });
    await apiPaymentWebhookService.deliverPaymentSucceeded('queued');
    expect(mocks.resolveSubscription).toHaveBeenCalledWith('merchant-active');
    expect(mocks.httpsRequest).toHaveBeenCalledOnce();
  });

  it('rejects insecure, credentialed, and private production targets', async () => {
    await expect(validateWebhookUrl('http://example.com')).rejects.toBeInstanceOf(ApiPaymentWebhookValidationError);
    await expect(validateWebhookUrl('https://user:pass@example.com')).rejects.toBeInstanceOf(ApiPaymentWebhookValidationError);
    await expect(validateWebhookUrl('https://127.0.0.1/hook')).rejects.toBeInstanceOf(ApiPaymentWebhookValidationError);
    await expect(validateWebhookUrl('http://localhost:4321/hook', true)).resolves.toBe('http://localhost:4321/hook');
  });

  it('journals every terminal partner payment event with a stable event key', async () => {
    const order = { id: 'payment-events', merchant_profile_id: 'merchant-1', environment: 'live' as const,
      merchant_transaction_id: 'tx-events', total_amount: 100, fee_amount: 3, currency: 'EUR',
      paid_at: new Date() };
    for (const event of ['payment.failed', 'payment.cancelled', 'payment.expired', 'payment.refunded'] as const) {
      mocks.poolQuery.mockReset();
      mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 'endpoint-1', environment: 'live', webhook_url: 'https://8.8.8.8/hook', signing_secret: 'secret' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] });
      await expect(apiPaymentWebhookService.enqueuePaymentEvent({ query: mocks.poolQuery } as any, order, event))
        .resolves.toBe('delivery-1');
      expect(mocks.poolQuery.mock.calls[1][1]).toEqual(expect.arrayContaining(['payment:payment-events:' + event, event]));
    }
  });

  it('pins a delivery to the public address validated for its hostname', async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);

    const target = await resolveWebhookTarget('https://merchant.example/webhook', false, resolver);

    expect(resolver).toHaveBeenCalledWith('merchant.example', { all: true, verbatim: true });
    expect(target).toMatchObject({ address: '8.8.8.8', family: 4 });
    expect(target.url.hostname).toBe('merchant.example');
  });

  it('leases due and stale deliveries without re-enqueuing their event key', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await apiPaymentWebhookService.processDue();

    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("d.status = 'processing' AND d.processing_started_at < now() - interval '10 minutes'"),
      [7, expect.any(String)],
    );
  });

  it('schedules a failed first attempt using the 60-second retry delay', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'endpoint-1', environment: 'sandbox', webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1', endpoint_id: 'endpoint-1', merchant_profile_id: 'merchant-1', event_type: 'payment.succeeded', attempts: 1, webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret', payload: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.httpsRequest.mockReset();
    mocks.httpsRequest.mockImplementationOnce(() => {
      const outgoing = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
      outgoing.end = () => outgoing.emit('error', new Error('down'));
      outgoing.destroy = (error) => outgoing.emit('error', error);
      return outgoing;
    });

    await apiPaymentWebhookService.enqueueAndDeliverPaymentSucceeded({
      id: 'payment-1', merchant_profile_id: 'merchant-1', environment: 'sandbox', merchant_transaction_id: 'merchant-tx-1', total_amount: 10, fee_amount: 0, currency: 'EUR', paid_at: '2026-07-24T01:00:00.000Z',
    });

    expect(mocks.poolQuery.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['failed', 60]));
  });

  it('dead-letters the seventh failed delivery attempt', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'endpoint-1', environment: 'sandbox', webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1', endpoint_id: 'endpoint-1', merchant_profile_id: 'merchant-1', event_type: 'payment.succeeded', attempts: 7, webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret', payload: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.httpsRequest.mockReset();
    mockHttpsResponse(500, 'error');

    await apiPaymentWebhookService.enqueueAndDeliverPaymentSucceeded({
      id: 'payment-1', merchant_profile_id: 'merchant-1', environment: 'sandbox', merchant_transaction_id: 'merchant-tx-1', total_amount: 10, fee_amount: 0, currency: 'EUR', paid_at: '2026-07-24T01:00:00.000Z',
    });

    expect(mocks.poolQuery.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['dead_lettered']));
  });

  it('does not bypass a failed delivery retry deadline during immediate enqueue', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'endpoint-1', environment: 'sandbox', webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1', created: false }] })
      .mockResolvedValueOnce({ rows: [] });

    await apiPaymentWebhookService.enqueueAndDeliverPaymentSucceeded({
      id: 'payment-1', merchant_profile_id: 'merchant-1', environment: 'sandbox', merchant_transaction_id: 'merchant-tx-1', total_amount: 10, fee_amount: 0, currency: 'EUR', paid_at: '2026-07-24T01:00:00.000Z',
    });

    const claim = mocks.poolQuery.mock.calls[2];
    expect(claim[0]).toContain("status = 'failed' AND next_attempt_at <= now()");
    expect(claim[1]).toEqual(['delivery-1', 7, expect.any(String)]);
  });

  it('updates delivery completion only when the claim lease remains owner', async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'endpoint-1', environment: 'sandbox', webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1', created: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'delivery-1', endpoint_id: 'endpoint-1', merchant_profile_id: 'merchant-1', event_type: 'payment.succeeded', attempts: 1, processing_lease_id: 'lease-1', webhook_url: 'https://8.8.8.8/webhooks', signing_secret: 'signing-secret', payload: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    await apiPaymentWebhookService.enqueueAndDeliverPaymentSucceeded({
      id: 'payment-1', merchant_profile_id: 'merchant-1', environment: 'sandbox', merchant_transaction_id: 'merchant-tx-1', total_amount: 10, fee_amount: 0, currency: 'EUR', paid_at: '2026-07-24T01:00:00.000Z',
    });

    const completion = mocks.poolQuery.mock.calls.at(-1);
    expect(completion?.[0]).toContain('processing_lease_id = $4');
    expect(completion?.[1]).toEqual(['delivery-1', 204, '', 'lease-1']);
  });
});
