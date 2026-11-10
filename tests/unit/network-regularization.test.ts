import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: vi.fn() } }));
import { optionsFor, REGULATOR_ROLE, sameSite } from '../../src/application/network-operations/regularization.ts';

const env = {
  MARKETPLACE_FRAPPE_CONGO_URL: 'https://congo.erp.example/', MARKETPLACE_FRAPPE_KONEKTAG_CG_URL: 'https://congo.erp.example/',
  MARKETPLACE_FRAPPE_EUROPE_URL: 'https://europe.erp.example/', PAWAPAY_API_URL: 'https://pawapay.example', PAWAPAY_API_TOKEN: 't',
  KTG_FR_STRIPE_LIVE_SECRET_KEY: 'sk',
} as NodeJS.ProcessEnv;
const recharge = (over: Record<string, unknown> = {}) => ({ kind: 'recharge', key: 'recharge:x', owner: 'KONEKTAG_CG', attemptId: 'x',
  provider: 'pawapay', reference: 'dep', configurationKey: null, amountMinor: 5200, currency: 'XAF', attemptState: 'pending',
  orderId: 'o', orderState: 'pending', credited: false, ...over }) as any;
const link = (over: Record<string, unknown> = {}) => ({ kind: 'link', key: 'link-pay:s', owner: 'CONGO', slug: 's', checkoutIntentId: 'c',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), linkStatus: 'ISSUED', currency: 'XAF', amountMinor: 1500, transaction: null,
  deliveries: [], ...over }) as any;
const regulator = { user: 'u', roles: [REGULATOR_ROLE] };
const reader = { user: 'u', roles: ['Link Pay Manager'] };
const view = (options: any[]) => options.map(o => [o.option, o.available, o.reason]);

describe('regularization rules', () => {
  it('a Network site owns the operations of its Frappe site, under any of its keys, and nothing else', () => {
    expect(sameSite('CONGO', 'KONEKTAG_CG', env)).toBe(true);
    expect(sameSite('CONGO', 'CONGO', env)).toBe(true);
    expect(sameSite('EUROPE', 'KONEKTAG_CG', env)).toBe(false);
    expect(sameSite('CONGO', null, env)).toBe(false);
  });

  it('pending recharge: verification for readers, manual results for the regulator role only', () => {
    expect(view(optionsFor(recharge(), regulator, env))).toEqual([['verify', true, null], ['confirm_paid', true, null], ['confirm_failed', true, null]]);
    expect(view(optionsFor(recharge(), reader, env))).toEqual([['verify', true, null], ['confirm_paid', false, 'ROLE_REQUIRED'], ['confirm_failed', false, 'ROLE_REQUIRED']]);
  });

  it('final recharge: no manual result; verification needs the account that processed the payment', () => {
    expect(view(optionsFor(recharge({ attemptState: 'succeeded' }), regulator, env)).slice(1)).toEqual([
      ['confirm_paid', false, 'FINAL_STATUS_PAID'], ['confirm_failed', false, 'FINAL_STATUS_PAID']]);
    expect(optionsFor(recharge({ provider: 'stripe', configurationKey: 'KTG_FR_STRIPE_LIVE' }), reader, env)[0].available).toBe(true);
    expect(optionsFor(recharge({ provider: 'stripe', configurationKey: 'KTG_LB_STRIPE_LIVE' }), reader, env)[0].reason).toBe('STRIPE_ACCOUNT_NOT_CONFIGURED');
    expect(optionsFor(recharge({ provider: 'stripe', configurationKey: null }), reader, env)[0].reason).toBe('STRIPE_ACCOUNT_UNKNOWN');
    expect(optionsFor(recharge({ configurationKey: 'KTG_CG_PAWAPAY_LIVE' }), reader, env)[0].reason).toBe('PAWAPAY_ACCOUNT_NOT_CONFIGURED');
  });

  it('Link Pay: no failure to record; a payment can be confirmed only when the API recorded it', () => {
    expect(view(optionsFor(link(), regulator, env))).toEqual([['verify', true, null], ['confirm_paid', false, 'NO_PAYMENT_RECORDED'],
      ['confirm_failed', false, 'LINK_EXPIRES_AT_DEADLINE']]);
    expect(optionsFor(link({ transaction: { id: 't', operationId: 'k', grossMinor: 1500 } }), regulator, env)[1].available).toBe(true);
  });
});
