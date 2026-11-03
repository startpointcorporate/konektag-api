import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, type RouteHandler } from '../../src/api/http';
import { OnboardingError } from '../../src/domain/DomainErrors';
const m = vi.hoisted(() => ({ query: vi.fn(), getFeatures: vi.fn(), savePreferences: vi.fn(), completeOnboarding: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/application/services/preferences-service.ts', () => ({ preferencesService: m }));
vi.mock('../../src/application/services/onboarding-service.ts', () => ({ onboardingService: m }));
import { GET as read } from '../../src/api/routes/preferences/index';
import { GET as dashboard, PUT as update } from '../../src/api/routes/preferences/dashboard';
import { GET as features } from '../../src/api/routes/preferences/features';
import { POST as save } from '../../src/api/routes/preferences/save';
import { POST as complete } from '../../src/api/routes/preferences/complete';
const c = (path = '', body?: unknown, authenticated = true) => {
  const context = createContext(new Request(`https://api.invalid/api/preferences${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  if (authenticated) context.locals.user = { id: 'user-1', keycloak_id: 'kc-owner' }; return context;
};
beforeEach(() => { vi.resetAllMocks(); m.query.mockResolvedValue({ rows: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); })); });
describe('preferences', () => {
  it.each([['read', read], ['dashboard', dashboard], ['update', update], ['save', save], ['complete', complete]] as [string, RouteHandler][])('%s refuses anonymous access before side effects', async (_, handler) => {
    expect((await handler(c('', {}, false))).status).toBe(401);
    expect(m.query).not.toHaveBeenCalled(); expect(m.savePreferences).not.toHaveBeenCalled(); expect(m.completeOnboarding).not.toHaveBeenCalled();
  });
  it('returns the available feature contract', async () => {
    m.getFeatures.mockResolvedValue([{ key: 'wallet', label: 'Wallet' }]);
    expect(await (await features(c('/features'))).json()).toEqual([{ key: 'wallet', label: 'Wallet' }]); expect(m.getFeatures).toHaveBeenCalledOnce();
  });
  it('returns the stored dashboard widgets only for the session principal', async () => {
    m.query.mockResolvedValue({ rows: [{ layout: { widgets: ['wallet'] }, role: 'merchant' }] });
    expect(await (await read(c())).json()).toEqual({ widgets: ['wallet'], role: 'merchant' });
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = $1'), ['kc-owner']);
  });
  it('rejects an unknown section without querying preferences', async () => {
    const response = await read(c('?section=other')); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'Unknown section' }); expect(m.query).not.toHaveBeenCalled();
  });
  it('keeps the historical dashboard fallback on database failure', async () => {
    m.query.mockRejectedValue(new Error('offline'));
    expect(await (await dashboard(c('/dashboard'))).json()).toEqual({ layout: { widgets: [] }, role: 'personal' });
  });
  it('returns a stored layout and role', async () => {
    m.query.mockResolvedValue({ rows: [{ layout: { widgets: ['history'] }, role: 'personal' }] });
    expect(await (await dashboard(c('/dashboard'))).json()).toEqual({ layout: { widgets: ['history'] }, role: 'personal' });
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = $1'), ['kc-owner']);
  });
  it('upserts layout for the session owner, ignoring a forged user id', async () => {
    expect(await (await update(c('/dashboard', { layout: { widgets: ['history'] }, userId: 'victim' }))).json()).toEqual({ success: true });
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (user_id)'), ['kc-owner', JSON.stringify({ widgets: ['history'] })]);
  });
  it('validates feature selection before saving', async () => {
    const response = await save(c('/save', { featureKeys: [] })); expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ errors: { featureKeys: expect.any(Array) } }); expect(m.savePreferences).not.toHaveBeenCalled();
  });
  it('saves the selected features for the authenticated user', async () => {
    expect(await (await save(c('/save', { featureKeys: ['wallet'], userId: 'victim' }))).json()).toEqual({ message: 'Preferences saved' });
    expect(m.savePreferences).toHaveBeenCalledWith('user-1', ['wallet']);
  });
  it('reports a rejected feature selection', async () => {
    m.savePreferences.mockRejectedValue(new OnboardingError('INVALID_FEATURES')); const response = await save(c('/save', { featureKeys: ['unknown'] }));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'INVALID_FEATURES' });
  });
  it('completes onboarding for the authenticated user and keeps the frontend redirect', async () => {
    expect(await (await complete(c('/complete', {}))).json()).toEqual({ message: 'Onboarding completed', redirect: 'dashboard' });
    expect(m.completeOnboarding).toHaveBeenCalledWith('user-1');
  });
  it('preserves invalid state transition errors', async () => {
    m.completeOnboarding.mockRejectedValue(new OnboardingError('INVALID_TRANSITION')); const response = await complete(c('/complete', {}));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'INVALID_TRANSITION' });
  });
});
