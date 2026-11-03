import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/api/router';
import { routes } from '../../src/api/registry';
import type { Middleware, RequestContext } from '../../src/api/http';

const handlers = vi.hoisted(() => ({ POST: vi.fn(), GET: vi.fn() }));
vi.mock('../../src/api/routes/pay/payments', () => ({ POST: handlers.POST }));
vi.mock('../../src/api/routes/pay/payments/[id]', () => ({ GET: handlers.GET }));
const pass: Middleware = async (_, next) => next();
beforeEach(() => vi.clearAllMocks());

describe('historical payment aliases', () => {
  it.each([
    ['/v1/payments', '/api/pay/payments', 'POST'],
    ['/v1/payments/{id}', '/api/pay/payments/{id}', 'GET'],
  ])('loads the existing handler for %s', async (alias, canonical, method) => {
    const legacy = routes.find(route => route.path === alias)!;
    const current = routes.find(route => route.path === canonical)!;
    expect(legacy.methods).toEqual([method]);
    expect(await legacy.load()).toBe(await current.load());
  });

  it('uses the canonical path for authentication/idempotency and preserves request and response data', async () => {
    const body = ' { "subtotal": 20, "label": "test" }\n';
    handlers.POST.mockImplementation(async (ctx: RequestContext) => {
      expect(ctx.request.method).toBe('POST');
      expect(await ctx.request.text()).toBe(body);
      expect(ctx.request.headers.get('authorization')).toBe('Bearer test');
      expect(ctx.request.headers.get('x-idempotency-key')).toBe('same-key');
      expect(ctx.cookies.get('konektag_access_token')?.value).toBe('session');
      expect(ctx.url.search).toBe('?lang=fr');
      return new Response('{"order":"existing"}', { status: 201, headers: { 'content-type': 'application/json', 'x-existing': 'unchanged' } });
    });
    const middleware: Middleware = async (ctx, next) => {
      expect(ctx.url.pathname).toBe('/api/pay/payments');
      expect(new URL(ctx.request.url).pathname).toBe('/api/pay/payments');
      ctx.cookies.set('access', 'refreshed', { path: '/', httpOnly: true });
      ctx.cookies.set('refresh', 'refreshed', { path: '/', httpOnly: true });
      return next();
    };
    const response = await dispatch(new Request('https://api.invalid/v1/payments/?lang=fr', {
      method: 'POST', body, headers: { authorization: 'Bearer test', 'x-idempotency-key': 'same-key', cookie: 'konektag_access_token=session' },
    }), '127.0.0.1', middleware);
    expect(response.status).toBe(201);
    expect(response.headers.get('x-existing')).toBe('unchanged');
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(await response.text()).toBe('{"order":"existing"}');
    expect(handlers.POST).toHaveBeenCalledOnce();
  });

  it('decodes the payment id and preserves the existing GET response', async () => {
    handlers.GET.mockImplementation((ctx: RequestContext) => {
      expect(ctx.params.id).toBe('order one');
      expect(ctx.url.pathname).toBe('/api/pay/payments/order%20one');
      return new Response('{"error":"existing"}', { status: 404 });
    });
    const response = await dispatch(new Request('https://api.invalid/v1/payments/order%20one'), '', pass);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"existing"}');
  });

  it('keeps middleware refusals, without invoking a handler', async () => {
    const response = await dispatch(new Request('https://api.invalid/v1/payments', { method: 'POST', body: '{}' }), '', async () => Response.json({ error: 'IDEMPOTENCY_KEY_REQUIRED' }, { status: 400 }));
    expect(response.status).toBe(400);
    expect(handlers.POST).not.toHaveBeenCalled();
  });

  it('retains method restrictions, HEAD behavior and invalid-encoding errors', async () => {
    const invalidMethod = await dispatch(new Request('https://api.invalid/v1/payments', { method: 'DELETE' }), '', pass);
    expect(invalidMethod.status).toBe(405);
    expect(invalidMethod.headers.get('allow')).toBe('POST');
    handlers.GET.mockResolvedValue(new Response('existing'));
    const head = await dispatch(new Request('https://api.invalid/v1/payments/one', { method: 'HEAD' }), '', pass);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await dispatch(new Request('https://api.invalid/v1/payments/%FF'), '', pass)).status).toBe(400);
  });

  it('leaves /g/{id} outside the API registry', () => {
    expect(routes.some(route => route.pattern.test('/g/existing'))).toBe(false);
  });
});
