import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ query: vi.fn(), decide: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/infrastructure/media-storage.ts', () => ({ merchantMediaStorage: {} }));
vi.mock('../../src/application/services/entitlement-decision-service.ts', async original => ({
  ...await original<any>(), entitlementDecisionService: { decide: m.decide },
}));
import { GET as stats } from '../../src/api/routes/merchant/analytics/stats.ts';
import { GET as csv } from '../../src/api/routes/merchant/analytics/export.ts';

let candidates: Array<{ id: string; is_primary: boolean }>;
let allowed: boolean;
const businessCalls = () => m.query.mock.calls.filter(([sql]) => sql.includes('konektag.profile_analytics'));
beforeEach(() => {
  vi.resetAllMocks(); allowed = true; candidates = [{ id: 'A', is_primary: false }];
  m.decide.mockResolvedValue({ allowed: true });
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('WHERE slug =')) return { rows: params[0] === 'missing' || params[0] === '' ? [] : [{ id: params[0] }] };
    if (sql.includes('SELECT mp.id, mm.is_primary')) return { rows: candidates };
    if (sql.includes('SELECT 1')) return { rows: allowed && params[0] === 'A' ? [{ '?column?': 1 }] : [] };
    if (sql.includes('konektag.profile_analytics')) return { rows: [] };
    throw new Error('Unexpected SQL: ' + sql);
  });
});
for (const [name, handler, count] of [['stats', stats, 6], ['CSV', csv, 1]] as const) {
  describe(`SEC-1 ${name}`, () => {
    const call = (slug: string | null = 'A', user: unknown = { id: 'actor' }) => handler({
      locals: { user }, request: new Request('http://localhost/api/analytics' + (slug === null ? '' : '?slug=' + slug)),
    } as any);
    it('rejects anonymous before any SQL', async () => {
      expect((await call('A', null)).status).toBe(401); expect(m.query).not.toHaveBeenCalled();
    });
    it('filters every analytics query by the authorized commerce', async () => {
      const response = await call(); expect(response.status).toBe(200);
      expect(businessCalls()).toHaveLength(count);
      for (const [sql, params] of businessCalls()) {
        expect(sql).toMatch(/(?:WHERE|AND)\s+(?:pa\.)?profile_id\s*=\s*\$2/); expect(params).toEqual(name === 'stats' ? ['720 hours', 'A', expect.any(Date)] : ['30 days', 'A']);
      }
      const guard = m.query.mock.calls.find(([sql]) => sql.includes('SELECT 1'))!;
      expect(guard[0]).toContain("mm.status = 'active'");
      expect(guard[0]).toContain("mm.role IN ('owner', 'manager')");
      expect(guard[1]).toEqual(['A', 'actor']);
      if (name === 'stats') expect(await response.json()).toEqual({ views: { total: 0, previousTotal: 0, trend: null }, messages: { total: 0, trend: null }, phoneClicks: { total: 0, trend: null }, directionClicks: { total: 0, trend: null }, externalLinks:{totalClicks:0,topLink:null,topSocial:null,items:[]},sharing:{shares:0,returns:0,returnRate:0,items:[]},socialJourney:{menuViews:0,catalogViews:0,phoneClicks:0,directionClicks:0,reservationClicks:0,externalLinkClicks:0},daily: [] });
      else expect(await response.text()).toBe('Date,Vues,Messages,Appels,Itinéraires\n');
    });
    it.each(['B', 'missing', ''])('rejects foreign/unknown/empty slug %s before analytics', async slug => {
      expect((await call(slug)).status).toBe(slug === 'B' ? 403 : 404);
      expect(businessCalls()).toHaveLength(0); expect(m.decide).not.toHaveBeenCalled();
    });
    it('rejects a membership denied by the existing guard', async () => {
      allowed = false; expect((await call()).status).toBe(403); expect(businessCalls()).toHaveLength(0);
    });
    it('resolves a sole authorized commerce without slug', async () => {
      expect((await call(null)).status).toBe(200);
      const resolution = m.query.mock.calls[0][0];
      expect(resolution).toContain("mm.status = 'active'");
      expect(resolution).toContain("mm.role IN ('owner', 'manager')");
      for (const [, params] of businessCalls()) expect(params[1]).toBe('A');
    });
    it('rejects no eligible commerce without slug', async () => {
      candidates = []; expect((await call(null)).status).toBe(404); expect(businessCalls()).toHaveLength(0);
    });
    it.each([false, true])('requires slug for multiple equal-priority memberships (primary=%s)', async is_primary => {
      candidates = [{ id: 'A', is_primary }, { id: 'B', is_primary }];
      expect((await call(null)).status).toBe(400); expect(businessCalls()).toHaveLength(0);
    });
    it('uses the unique primary membership', async () => {
      candidates = [{ id: 'B', is_primary: false }, { id: 'A', is_primary: true }];
      expect((await call(null)).status).toBe(200);
      for (const [, params] of businessCalls()) expect(params[1]).toBe('A');
    });
    it('fails closed when authorization storage fails', async () => {
      m.query.mockRejectedValue(new Error('authorization unavailable'));
      expect((await call()).status).toBe(500); expect(businessCalls()).toHaveLength(0);
    });
  });
}
