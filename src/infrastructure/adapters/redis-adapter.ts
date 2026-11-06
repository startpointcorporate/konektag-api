import { createClient, type RedisClientType } from 'redis';
import { OnboardingError } from '../../domain/DomainErrors.ts';

export interface KycStatusEvent {
  status: string;
  timestamp: string;
  step?: string;
  reason?: string;
}

export interface PaymentStatusEvent {
  state: string;
  paymentMethod: string | null;
  paidAt: string | null;
  timestamp: string;
}

export interface PaymentStatusSubscription extends AsyncIterable<PaymentStatusEvent> {
  unsubscribe: () => Promise<void>;
}

export class RedisAdapter {
  private client: RedisClientType;
  private subscriberClient: RedisClientType | null = null;
  private paymentSubscriberClients = new Set<RedisClientType>();

  constructor(url: string) {
    // Health checks must fail within the Kubernetes probe budget instead of
    // waiting forever for the client's default reconnect loop.
    this.client = createClient({
      url,
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  async disconnect(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
    await this.subscriberClient?.quit();
    const paymentSubscribers = [...this.paymentSubscriberClients];
    this.paymentSubscriberClients.clear();
    await Promise.all(paymentSubscribers.map((client) => client.quit().catch(() => undefined)));
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      const result = await this.client.ping();
      return result === 'PONG';
    } catch { return false; }
  }

  // ── OTP ──────────────────────────────────────────

  async setOtp(identifier: string): Promise<string> {
    const key = identifier.trim().toLowerCase();
    await this.ensureConnected();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const ttl = parseInt(process.env.OTP_TTL_SECONDS ?? '300');
    await this.client.set(`otp:${key}`, code, { EX: ttl });
    await this.client.set(`otp:attempts:${key}`, '0', { EX: ttl });
    return code;
  }

  async verifyOtp(identifier: string, code: string): Promise<boolean> {
    const key = identifier.trim().toLowerCase();
    await this.ensureConnected();
    const maxAttempts = parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5');
    const attemptsStr = await this.client.get(`otp:attempts:${key}`);
    const attempts = parseInt(attemptsStr ?? '0');
    if (attempts >= maxAttempts) throw new OnboardingError('OTP_TOO_MANY_ATTEMPTS');

    const stored = await this.client.get(`otp:${key}`);
    if (!stored) throw new OnboardingError('OTP_EXPIRED');

    if (stored !== code) {
      await this.client.incr(`otp:attempts:${key}`);
      return false;
    }

    await this.client.set(`otp:verified:${key}`, '1', { EX: 300 });
    await this.client.del(`otp:${key}`);
    await this.client.del(`otp:attempts:${key}`);
    return true;
  }

  async checkOtpVerification(email: string): Promise<boolean> {
    const key = email.trim().toLowerCase();
    await this.ensureConnected();
    return (await this.client.get(`otp:verified:${key}`)) === '1';
  }

  async consumeOtpVerification(email: string): Promise<boolean> {
    const key = email.trim().toLowerCase();
    await this.ensureConnected();
    return (await this.client.del(`otp:verified:${key}`)) === 1;
  }

  // ── SSE Pub/Sub ──────────────────────────────────

  async publishKycStatus(userId: string, event: KycStatusEvent): Promise<void> {
    await this.ensureConnected();
    await this.client.publish(`kyc:status:${userId}`, JSON.stringify(event));
  }

  async subscribeKycStatus(
    userId: string,
  ): Promise<{ unsubscribe: () => Promise<void>; [Symbol.asyncIterator]: () => AsyncIterator<KycStatusEvent> }> {
    // Nettoie l'ancien subscriber s'il existe
    if (this.subscriberClient) {
      try { await this.subscriberClient.quit(); } catch {}
      this.subscriberClient = null;
    }

    const messages: KycStatusEvent[] = [];
    let resolveNext: ((value: IteratorResult<KycStatusEvent>) => void) | null = null;
    let done = false;

    const handleMessage = (message: string) => {
      const event = JSON.parse(message) as KycStatusEvent;
      if (resolveNext) {
        resolveNext({ value: event, done: false });
        resolveNext = null;
      } else {
        messages.push(event);
      }
    };

    this.subscriberClient = this.client.duplicate();
    await this.subscriberClient.connect();
    await this.subscriberClient.subscribe(`kyc:status:${userId}`, handleMessage);

    this.subscriberClient.on('message', handleMessage);

    return {
      unsubscribe: async () => {
        done = true;
        if (this.subscriberClient) {
          try { await this.subscriberClient.unsubscribe(`kyc:status:${userId}`); } catch {}
          try { await this.subscriberClient.quit(); } catch {}
          this.subscriberClient = null;
        }
      },
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<KycStatusEvent>> => {
          if (done) return { value: undefined, done: true };
          if (messages.length > 0) {
            return { value: messages.shift()!, done: false };
          }
          return new Promise(resolve => { resolveNext = resolve; });
        },
      }),
    };
  }

  async publishPaymentStatus(orderId: string, event: PaymentStatusEvent): Promise<void> {
    await this.ensureConnected();
    await this.client.publish(`payment:status:${orderId}`, JSON.stringify(event));
  }

  async subscribePaymentStatus(orderId: string): Promise<PaymentStatusSubscription> {
    // Payment streams are concurrent. Each stream owns its duplicate client so one
    // browser disconnect can never unsubscribe another checkout listener.
    const subscriberClient = this.client.duplicate();
    this.paymentSubscriberClients.add(subscriberClient);
    const messages: PaymentStatusEvent[] = [];
    let resolveNext: ((value: IteratorResult<PaymentStatusEvent>) => void) | null = null;
    let done = false;
    let cleanupPromise: Promise<void> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      resolveNext?.({ value: undefined, done: true });
      resolveNext = null;
    };

    try {
      await subscriberClient.connect();
      await subscriberClient.subscribe(`payment:status:${orderId}`, (message) => {
        try {
          const event = JSON.parse(message) as PaymentStatusEvent;
          if (typeof event.state !== 'string'
            || (event.paymentMethod !== null && typeof event.paymentMethod !== 'string')
            || (event.paidAt !== null && typeof event.paidAt !== 'string')
            || typeof event.timestamp !== 'string') return;
          if (done) return;
          if (resolveNext) {
            resolveNext({ value: event, done: false });
            resolveNext = null;
          } else {
            messages.push(event);
          }
        } catch {
          // Ignore malformed Pub/Sub payloads; they must never terminate an SSE stream.
        }
      });
    } catch (error) {
      this.paymentSubscriberClients.delete(subscriberClient);
      try { await subscriberClient.quit(); } catch {}
      throw error;
    }
    subscriberClient.on('end', finish);

    return {
      unsubscribe: () => {
        if (cleanupPromise) return cleanupPromise;
        finish();
        this.paymentSubscriberClients.delete(subscriberClient);
        cleanupPromise = (async () => {
          if (!subscriberClient.isOpen) return;
          try { await subscriberClient.unsubscribe(`payment:status:${orderId}`); } catch {}
          try { await subscriberClient.quit(); } catch {}
        })();
        return cleanupPromise;
      },
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<PaymentStatusEvent>> => {
          if (done) return { value: undefined, done: true };
          if (messages.length > 0) return { value: messages.shift()!, done: false };
          return new Promise((resolve) => { resolveNext = resolve; });
        },
      }),
    };
  }

  // ── Rate limiting ────────────────────────────────

  async checkRateLimit(key: string, maxRequests: number, windowSec: number): Promise<boolean> {
    await this.ensureConnected();
    const current = await this.client.incr(key);
    if (current === 1) await this.client.expire(key, windowSec);
    return current <= maxRequests;
  }

  // ── Short leases and replay records ──────────────

  /** Sets the key only when absent. Returns true when this caller now owns it. */
  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    await this.ensureConnected();
    return (await this.client.set(key, value, { NX: true, PX: ttlMs })) === 'OK';
  }

  /** Deletes the key only when it still holds the caller's value (lease release). */
  async deleteIfEquals(key: string, value: string): Promise<void> {
    await this.ensureConnected();
    await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [value] },
    );
  }

  async getValue(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async setValue(key: string, value: string, ttlSec: number): Promise<void> {
    await this.ensureConnected();
    await this.client.set(key, value, { EX: ttlSec });
  }

  // ── Session cache ────────────────────────────────

  async cacheSession(keycloakId: string, data: Record<string, unknown>, ttl = 3600): Promise<void> {
    await this.client.set(`session:${keycloakId}`, JSON.stringify(data), { EX: ttl });
  }

  async getCachedSession(keycloakId: string): Promise<Record<string, unknown> | null> {
    const raw = await this.client.get(`session:${keycloakId}`);
    return raw ? JSON.parse(raw) : null;
  }
}

// Singleton instance
const redisUrl = process.env.REDIS_URL ?? (() => {
  const host = 'common-redis';
  const port = 6379;
  const pass = process.env.REDIS_PASSWORD;
  if (pass) return `redis://:${encodeURIComponent(pass)}@${host}:${port}`;
  return `redis://${host}:${port}`;
})();
export const redisAdapter = new RedisAdapter(redisUrl);
