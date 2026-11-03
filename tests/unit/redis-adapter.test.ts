import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('redis', () => ({ createClient: mocks.createClient }));

import { RedisAdapter } from '../../src/infrastructure/adapters/redis-adapter.ts';

describe('RedisAdapter', () => {
  it('bounds initial connection failures for readiness checks', () => {
    mocks.createClient.mockReturnValue({ isOpen: false });

    new RedisAdapter('redis://redis-master:6379');

    expect(mocks.createClient).toHaveBeenCalledWith({
      url: 'redis://redis-master:6379',
      socket: { connectTimeout: 1_000, reconnectStrategy: false },
    });
  });

  it('rejects a wrong OTP and creates a consumable proof only for the correct code', async () => {
    const values = new Map<string, string>([['otp:user@example.com', '123456'], ['otp:attempts:user@example.com', '0']]);
    const client = {
      isOpen: true,
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      incr: vi.fn(async (key: string) => { const value = Number(values.get(key) ?? 0) + 1; values.set(key, String(value)); return value; }),
      del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0),
    };
    mocks.createClient.mockReturnValue(client);
    const adapter = new RedisAdapter('redis://test');

    await expect(adapter.verifyOtp(' User@Example.com ', '000000')).resolves.toBe(false);
    expect(await adapter.checkOtpVerification('user@example.com')).toBe(false);
    await expect(adapter.verifyOtp('user@example.com', '123456')).resolves.toBe(true);
    expect(await adapter.checkOtpVerification('USER@EXAMPLE.COM')).toBe(true);
    expect(await adapter.consumeOtpVerification('user@example.com')).toBe(true);
    expect(await adapter.consumeOtpVerification('user@example.com')).toBe(false);
  });
});
