import { parse, serialize, type SerializeOptions } from 'cookie';

export class RequestCookies {
  private values: Record<string, string | undefined>;
  readonly outgoing: string[] = [];
  constructor(header = '') { this.values = parse(header); }
  get(name: string) {
    const value = this.values[name];
    return value === undefined ? undefined : { value, json: () => JSON.parse(value) };
  }
  has(name: string) { return this.values[name] !== undefined; }
  set(name: string, value: string | object, options: SerializeOptions = {}) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.values[name] = text;
    this.outgoing.push(serialize(name, text, options));
  }
  delete(name: string, options: SerializeOptions = {}) {
    delete this.values[name];
    this.outgoing.push(serialize(name, '', { ...options, expires: new Date(0), maxAge: 0 }));
  }
}
export interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string | undefined>;
  locals: { user?: any; [key: string]: any };
  cookies: RequestCookies;
  clientAddress: string;
  redirect: (path: string, status?: number) => Response;
}
export type RouteHandler = (context: RequestContext) => Response | Promise<Response>;
export type MiddlewareNext = () => Promise<Response>;
export type Middleware = (context: RequestContext, next: MiddlewareNext) => Promise<Response>;
export function createContext(request: Request, params: RequestContext['params'] = {}, clientAddress = ''): RequestContext {
  return {
    request, url: new URL(request.url), params, locals: {}, clientAddress,
    cookies: new RequestCookies(request.headers.get('cookie') ?? ''),
    redirect: (path, status = 302) => new Response(null, { status, headers: { location: path } }),
  };
}
