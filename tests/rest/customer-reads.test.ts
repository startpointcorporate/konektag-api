import { beforeEach, describe, expect, it, vi } from 'vitest';
import { context } from './helpers';
import { OnboardingError } from '../../src/domain/DomainErrors';
const m = vi.hoisted(() => ({ query: vi.fn(), listForUser: vi.fn(), unreadCount: vi.fn(), markAllAsRead: vi.fn(), getStatus: vi.fn(), skipKyc: vi.fn(), currentChallenge: vi.fn(), checkUserKycVerified: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/application/services/notification-service.ts', () => ({ notificationService: m }));
vi.mock('../../src/application/services/kyc-service.ts', () => ({ kycService: m }));
vi.mock('../../src/application/services/onboarding-service.ts', () => ({ onboardingService: m }));
vi.mock('../../src/application/services/activation-challenge-service.ts', () => ({ activationChallengeService: m }));
vi.mock('../../src/application/services/user-kyc-gate-service.ts', () => ({ checkUserKycVerified: m.checkUserKycVerified }));
import { GET as notifications } from '../../src/api/routes/notifications/index';
import { GET as count } from '../../src/api/routes/notifications/count';
import { POST as markRead } from '../../src/api/routes/notifications/mark-all-read';
import { GET as orders } from '../../src/api/routes/orders/index';
import { GET as bookings } from '../../src/api/routes/bookings/index';
import { GET as promotions } from '../../src/api/routes/promotions/index';
import { GET as kycStatus } from '../../src/api/routes/kyc/status';
import { POST as skipKyc } from '../../src/api/routes/kyc/skip';
import { GET as gate } from '../../src/api/routes/account/kyc-gate';
import { GET as challenge } from '../../src/api/routes/activation-challenge/current';
beforeEach(() => { vi.resetAllMocks(); m.query.mockResolvedValue({ rows: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); })); });
describe('notifications', () => {
  for (const [path,handler,service,result,envelope] of [
    ['/api/notifications', notifications, m.listForUser, [{ id: 'notice-1', read: false }], { notifications: [{ id: 'notice-1', read: false }] }],
    ['/api/notifications/count', count, m.unreadCount, 3, { count: 3 }],
    ['/api/notifications/mark-all-read', markRead, m.markAllAsRead, undefined, { success: true }],
  ] as const) {
    it(`${path} scopes success to the session owner`, async () => {
      service.mockResolvedValue(result); expect(await (await handler(context(path))).json()).toEqual(envelope);
      expect(service).toHaveBeenCalledWith('kc-owner');
    });
    it(`${path} refuses anonymous access before any read or update`, async () => {
      const response = await handler(context(path, undefined, false)); expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' }); expect(service).not.toHaveBeenCalled();
    });
    it(`${path} reports service failure without claiming success`, async () => {
      service.mockRejectedValue(new Error('NOTIFICATIONS_UNAVAILABLE')); const response = await handler(context(path));
      expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: 'NOTIFICATIONS_UNAVAILABLE' });
    });
  }
});
describe('orders and bookings', () => {
  for (const [path,handler,kind] of [['/api/orders',orders,'ORDER'],['/api/bookings',bookings,'RESERVATION']] as const) {
    it(`${path} keeps the anonymous empty contract without reading customer data`, async () => {
      expect(await (await handler(context(path,undefined,false))).json()).toEqual({ data: [], total: 0 }); expect(m.query).not.toHaveBeenCalled();
    });
    it(`${path} returns only the resolved customer's ${kind} rows with bounded pagination`, async () => {
      m.query.mockResolvedValueOnce({ rows: [{ id: 'db-owner' }] }).mockResolvedValueOnce({ rows: [{ id: 'operation-1', status: 'CONFIRMED' }] });
      expect(await (await handler(context(path+'?limit=9999&userId=victim'))).json()).toEqual({ data: [{ id: 'operation-1', status: 'CONFIRMED' }], total: 1 });
      expect(m.query).toHaveBeenNthCalledWith(1, expect.stringContaining('keycloak_id = $1'), ['kc-owner']);
      expect(m.query).toHaveBeenNthCalledWith(2, expect.stringContaining(`kind = '${kind}'`), ['db-owner',100]);
    });
    it(`${path} keeps the historical empty fallback on missing users or database failure`, async () => {
      expect(await (await handler(context(path))).json()).toEqual({ data: [], total: 0 }); expect(m.query).toHaveBeenCalledOnce();
      m.query.mockRejectedValue(new Error('offline')); expect(await (await handler(context(path))).json()).toEqual({ data: [], total: 0 });
    });
  }
});
describe('promotions', () => {
  it('filters active, unexpired promotions by a bound category and returns their data', async () => {
    m.query.mockResolvedValue({ rows: [{ id: 'promotion-1' }] }); expect(await (await promotions(context('/api/promotions?category=food&limit=3'))).json()).toEqual({ data: [{ id: 'promotion-1' }] });
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('p.is_active = true'), ['food',3]);
    expect(m.query.mock.calls[0][0]).toContain('p.category = $1'); expect(m.query.mock.calls[0][0]).toContain('p.end_date > now()');
  });
  it('preserves the explicit inactive filter and empty failure envelope', async () => {
    await promotions(context('/api/promotions?active=false')); expect(m.query.mock.calls[0][0]).not.toContain('p.is_active = true');
    m.query.mockRejectedValue(new Error('PROMOTIONS_UNAVAILABLE')); expect(await (await promotions(context('/api/promotions'))).json()).toEqual({ data: [], error: 'PROMOTIONS_UNAVAILABLE' });
  });
});
describe('KYC and activation', () => {
  for (const [path,handler,service,result,envelope] of [
    ['/api/kyc/status',kycStatus,m.getStatus,{ state: 'KYC_PENDING' },{ state: 'KYC_PENDING' }],
    ['/api/kyc/skip',skipKyc,m.skipKyc,undefined,{ message: 'KYC skipped' }],
    ['/api/activation-challenge/current',challenge,m.currentChallenge,{ remaining: 2 },{ challenge: { remaining: 2 } }],
  ] as const) {
    it(`${path} binds the result to the authenticated internal user`, async () => {
      service.mockResolvedValue(result); expect(await (await handler(context(path))).json()).toEqual(envelope); expect(service).toHaveBeenCalledWith('session-user');
    });
    it(`${path} refuses anonymous access without side effects`, async () => {
      expect((await handler(context(path,undefined,false))).status).toBe(401); expect(service).not.toHaveBeenCalled();
    });
  }
  it('returns a sanitized KYC status infrastructure error', async () => {
    m.getStatus.mockRejectedValue(new Error('private provider key')); expect(await (await kycStatus(context('/api/kyc/status'))).json()).toEqual({ error: 'SERVER_ERROR' });
  });
  it('preserves a forbidden KYC state transition', async () => {
    m.skipKyc.mockRejectedValue(new OnboardingError('INVALID_TRANSITION')); const response = await skipKyc(context('/api/kyc/skip'));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'INVALID_TRANSITION' });
  });
  it.each([true,false])('projects only KYC gate fields when verified=%s', async verified => {
    m.checkUserKycVerified.mockResolvedValue({ verified, state: 'KYC_VERIFIED', private: 'secret' });
    expect(await (await gate(context('/api/account/kyc-gate'))).json()).toEqual({ verified, state: 'KYC_VERIFIED' });
    expect(m.checkUserKycVerified).toHaveBeenCalledWith(expect.anything(),'session-user');
  });
  it('does not query the KYC gate for anonymous users', async () => {
    expect(await (await gate(context('/api/account/kyc-gate',undefined,false))).json()).toEqual({ error: 'UNAUTHORIZED' }); expect(m.checkUserKycVerified).not.toHaveBeenCalled();
  });
});
