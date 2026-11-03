import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../src/api/registry';
import { dispatch } from '../../src/api/router';
const m = vi.hoisted(() => ({ authenticate: vi.fn(), query: vi.fn(), connect: vi.fn(), validateToken: vi.fn() }));
vi.mock('../../src/application/services/user-api-key-service', () => ({ userApiKeyService: { authenticate: m.authenticate } }));
vi.mock('../../src/application/services/auth-service', () => ({ authService: { validateToken: m.validateToken } }));
vi.mock('../../src/infrastructure/database/pool', () => ({ default: { query: m.query, connect: m.connect } }));
vi.mock('../../src/application/services/merchant-api-key-service', () => ({ merchantApiKeyService: {} }));
import { onRequest } from '../../src/api/middleware/security';

const spec = parse(readFileSync('docs/openapi.yaml', 'utf8'));
// Generated at collection time from the actual OpenAPI contract, grouped by business domain.
// Neither transport nor credential rejection is claimed as complete business coverage.
const operations = Object.entries(spec.paths).flatMap(([path, item]: [string, any]) =>
  Object.keys(item).filter(method => /^(get|post|put|patch|delete|head|options|trace)$/.test(method)).map(method => ({
    path, method: method.toUpperCase(), domain: path.split('/')[2] || 'legacy',
  })));
beforeEach(() => {
  vi.resetAllMocks(); m.authenticate.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); }));
  m.query.mockImplementation(() => { throw new Error('Unexpected DB access'); });
  m.connect.mockImplementation(() => { throw new Error('Unexpected DB connection'); });
});
afterEach(() => vi.restoreAllMocks());
for (const domain of [...new Set(operations.map(op => op.domain))].sort()) {
  describe(domain, () => {
    for (const { path, method } of operations.filter(op => op.domain === domain)) {
      const concrete = path.replace(/\{([^}]+)\}/g, (_, key) => `test-${key}`);
      it(`[REST TRANSPORT ${method} ${path}] preserves routing, parameters, query, cookies and raw body`, async () => {
        const route = routes.find(r => r.path === path)!;
        const load = vi.spyOn(route, 'load').mockImplementation(() => { throw new Error('Unexpected handler load'); });
        const expectedParams = Object.fromEntries(route.keys.map(key => [key, `test-${key}`]));
        const raw = ' { "test": "transport-only" }\n';
        const hasBody = !['GET', 'HEAD'].includes(method);
        const middleware = vi.fn(async context => {
          expect(context.params).toEqual(expectedParams);
          expect(context.request.method).toBe(method);
          expect(context.url.pathname).toBe((('canonicalPath' in route ? route.canonicalPath : path) as string).replace(/\{([^}]+)\}/g, (_, key) => `test-${key}`));
          expect(context.url.searchParams.get('locale')).toBe('fr');
          expect(context.cookies.get('konektag_access_token')?.value).toBe('test-cookie');
          if (hasBody) expect(await context.request.text()).toBe(raw);
          return Response.json({ params: context.params, marker: 'transport' });
        });
        const response = await dispatch(new Request(`https://api.invalid${concrete}?locale=fr`, { method,
          headers: { cookie: 'konektag_access_token=test-cookie' }, ...(hasBody ? { body: raw } : {}) }), '127.0.0.1', middleware);
        expect(middleware).toHaveBeenCalledOnce(); expect(load).not.toHaveBeenCalled();
        if (method !== 'HEAD') expect(await response.json()).toEqual({ params: expectedParams, marker: 'transport' });
        expect(m.query).not.toHaveBeenCalled(); expect(m.connect).not.toHaveBeenCalled();
      });
      it(`[REST AUTH ${method} ${path}] refuses invalid personal API credentials before loading the handler`, async () => {
        const load = vi.spyOn(routes.find(r => r.path === path)!, 'load').mockImplementation(() => { throw new Error('Unexpected handler load'); });
        const response = await dispatch(new Request(`https://api.invalid${concrete}`, { method,
          headers: { Authorization: 'token invalid:invalid', 'X-Idempotency-Key': 'test-only' } }), '127.0.0.1', onRequest);
        expect(response.status).toBe(401);
        if (method !== 'HEAD') expect(await response.json()).toMatchObject({ error: 'INVALID_API_CREDENTIALS' });
        expect(m.authenticate).toHaveBeenCalledOnce(); expect(load).not.toHaveBeenCalled();
        expect(m.query).not.toHaveBeenCalled(); expect(m.connect).not.toHaveBeenCalled(); expect(m.validateToken).not.toHaveBeenCalled();
      });
    }
  });
}
