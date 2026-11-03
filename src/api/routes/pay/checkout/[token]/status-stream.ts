import type { RouteHandler } from '../../../../http';
import {
  apiPaymentCheckoutService,
  ApiPaymentNotFoundError,
  type ApiPaymentMethod,
  type ApiPaymentState,
} from '../../../../../application/services/pay/api-payment-checkout-service.ts';
import {
  redisAdapter,
  type PaymentStatusEvent,
  type PaymentStatusSubscription,
} from '../../../../../infrastructure/adapters/redis-adapter.ts';

const encoder = new TextEncoder();
const HEARTBEAT_MS = 25_000;
const STATES = new Set<ApiPaymentState>(['pending', 'processing', 'awaiting_mobile_money', 'paid', 'failed', 'expired']);
const METHODS = new Set<ApiPaymentMethod>(['sandbox', 'wallet', 'card', 'mobile_money']);

type SafePaymentStatus = {
  state: ApiPaymentState;
  paymentMethod: ApiPaymentMethod | null;
  paidAt: string | null;
  timestamp: string;
};

function statusEvent(status: { state: string; paymentMethod: string | null; paidAt: string | null }): SafePaymentStatus | null {
  if (!STATES.has(status.state as ApiPaymentState)) return null;
  if (status.paymentMethod !== null && !METHODS.has(status.paymentMethod as ApiPaymentMethod)) return null;
  let paidAt: string | null = null;
  if (status.paidAt !== null) {
    const parsedPaidAt = new Date(status.paidAt);
    if (Number.isNaN(parsedPaidAt.getTime())) return null;
    paidAt = parsedPaidAt.toISOString();
  }
  return {
    state: status.state as ApiPaymentState,
    paymentMethod: status.paymentMethod as ApiPaymentMethod | null,
    paidAt,
    timestamp: new Date().toISOString(),
  };
}

function send(controller: ReadableStreamDefaultController<Uint8Array>, event: SafePaymentStatus): void {
  controller.enqueue(encoder.encode(`event: payment_status\ndata: ${JSON.stringify(event)}\n\n`));
}

export const GET: RouteHandler = async ({ params }) => {
  const token = params.token || '';
  let initial: Awaited<ReturnType<typeof apiPaymentCheckoutService.getPublicOrder>>;
  try {
    initial = await apiPaymentCheckoutService.getPublicOrder(token);
  } catch (error) {
    const status = error instanceof ApiPaymentNotFoundError ? 404 : 500;
    return new Response(JSON.stringify({ error: status === 404 ? 'Checkout not found' : 'Unable to load checkout' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let subscription: PaymentStatusSubscription | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  const cleanup = async () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    await subscription?.unsubscribe();
    subscription = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        subscription = await redisAdapter.subscribePaymentStatus(initial.id);
        if (cancelled) {
          await cleanup();
          return;
        }

        // Read after subscribing so PostgreSQL remains authoritative across the subscribe race.
        const current = await apiPaymentCheckoutService.getPublicOrder(token);
        const currentStatus = statusEvent(current);
        if (currentStatus) send(controller, currentStatus);
        heartbeat = setInterval(() => {
          if (!cancelled) controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }, HEARTBEAT_MS);

        for await (const event of subscription) {
          const safeEvent = statusEvent(event as PaymentStatusEvent);
          if (safeEvent && !cancelled) send(controller, safeEvent);
        }
        if (!cancelled) controller.close();
      } catch {
        // A Redis outage must not turn a valid checkout token into an error response.
        if (!cancelled) {
          const initialStatus = statusEvent(initial);
          if (initialStatus) send(controller, initialStatus);
          controller.close();
        }
      } finally {
        await cleanup();
      }
    },
    async cancel() {
      cancelled = true;
      await cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
