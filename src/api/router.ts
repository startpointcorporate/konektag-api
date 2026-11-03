import { routes } from './registry';
import { createContext, type Middleware } from './http';
export async function dispatch(request: Request, clientAddress: string, middleware: Middleware): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    let params: Record<string,string>;
    try { params = Object.fromEntries(route.keys.map((key,i)=>[key,decodeURIComponent(match[i+1])])); }
    catch { return Response.json({ error: 'INVALID_PATH_ENCODING' }, { status: 400 }); }
    const context = createContext(request,params,clientAddress);
    const method = request.method === 'HEAD' && !route.methods.includes('HEAD') ? 'GET' : request.method;
    const response = await middleware(context, async () => {
      if (!route.methods.includes(method) && !route.methods.includes('ALL')) {
        return new Response(null,{status:405,headers:{Allow:route.methods.join(', ')}});
      }
      const handlers = await route.load() as Record<string,unknown>;
      const handler = (handlers[method] ?? handlers.ALL) as import('./http').RouteHandler;
      return handler(context);
    });
    const headers = new Headers(response.headers);
    for (const cookie of context.cookies.outgoing) headers.append('set-cookie',cookie);
    return new Response(request.method === 'HEAD' ? null : response.body,{status:response.status,statusText:response.statusText,headers});
  }
  return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
}
