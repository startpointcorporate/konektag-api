import { describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/api/router';
import { RequestCookies, createContext } from '../../src/api/http';
import { routes } from '../../src/api/registry';

describe('HTTP extraction',()=>{
  it('registers all source route methods with unique paths',()=>{
    expect(routes).toHaveLength(313);
    expect(routes.reduce((sum,r)=>sum+r.methods.length,0)).toBe(398);
    expect(new Set(routes.map(r=>r.path)).size).toBe(313);
  });
  it('extracts decoded dynamic parameters before authorization',async()=>{
    const middleware=vi.fn(async ctx=>Response.json(ctx.params));
    const response=await dispatch(new Request('https://api.invalid/api/k/send/recipient/abc%20def/qr'),'127.0.0.1',middleware);
    expect(await response.json()).toEqual({id:'abc def'});
  });
  it('keeps static routes ahead of dynamic ones',async()=>{
    let params:unknown;
    const response=await dispatch(new Request('https://api.invalid/api/pay/checkout/resume'),'127.0.0.1',async ctx=>{params=ctx.params;return new Response('guarded');});
    expect(response.status).toBe(200);
    expect(params).toEqual({});
    const staticRoute=routes.find(r=>r.path==='/api/pay/payments')!;
    expect(staticRoute.pattern.test('/api/pay/payments/')).toBe(true);
  });
  it('returns 405 with Allow when a method is absent',async()=>{
    const response=await dispatch(new Request('https://api.invalid/api/countries',{method:'DELETE'}),'',async(_,next)=>next());
    expect(response.status).toBe(405);expect(response.headers.get('allow')).toBe('GET');
  });
  it('returns 404 without executing middleware for unknown paths',async()=>{
    const middleware=vi.fn();expect((await dispatch(new Request('https://api.invalid/not-a-route'),'',middleware)).status).toBe(404);expect(middleware).not.toHaveBeenCalled();
  });
  it('rejects malformed percent encoding',async()=>{
    expect((await dispatch(new Request('https://api.invalid/api/k/send/recipient/%FF/qr'),'',vi.fn())).status).toBe(400);
  });
  it('keeps multiple Set-Cookie headers and sees refreshed tokens in the request',async()=>{
    const response=await dispatch(new Request('https://api.invalid/api/countries'),'',async ctx=>{
      ctx.cookies.set('access','one',{httpOnly:true,secure:true,path:'/'});
      ctx.cookies.set('refresh','two',{httpOnly:true,secure:true,path:'/'});
      expect(ctx.cookies.get('access')?.value).toBe('one');return new Response('ok');
    });
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });
  it('HEAD has no body, and redirects preserve a relative Location',async()=>{
    const response=await dispatch(new Request('https://api.invalid/api/countries',{method:'HEAD'}),'',async ctx=>ctx.redirect('/auth/login',303));
    expect(response.status).toBe(303);expect(response.headers.get('location')).toBe('/auth/login');expect(await response.text()).toBe('');
  });
  it('streams the original request body without changing webhook bytes',async()=>{
    const raw=' { "amount": 20 }\n';
    const ctx=createContext(new Request('https://api.invalid/api/webhooks/stripe',{method:'POST',body:raw}));
    expect(await ctx.request.text()).toBe(raw);
  });
  it('deletes the cookie in both request context and response',()=>{
    const cookies=new RequestCookies('access=old');cookies.delete('access',{path:'/'});expect(cookies.get('access')).toBeUndefined();expect(cookies.outgoing[0]).toContain('Max-Age=0');
  });
});
