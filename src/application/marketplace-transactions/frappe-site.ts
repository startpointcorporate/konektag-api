/**
 * Server-side Frappe client for marketplace transactions.
 *
 * A site is addressed by an allowlisted key (for example RESTODEMO). Its origin
 * and service token come only from MARKETPLACE_FRAPPE_<KEY>_URL / _API_KEY /
 * _API_SECRET. Nothing here is ever sent to the browser.
 */

export class FrappeSiteError extends Error {
  constructor(
    readonly code: 'SITE_NOT_CONFIGURED' | 'SITE_UNAVAILABLE' | 'SITE_REJECTED',
    readonly httpStatus: number | null = null,
    readonly excType: string | null = null,
    readonly serverMessage: string | null = null,
  ) {
    super(code);
  }
}

export type Filter = [string, string, unknown];

export interface FrappeSite {
  readonly key: string;
  readonly host: string;
  list(doctype: string, filters: Filter[], fields: string[], limit?: number): Promise<any[]>;
  get(doctype: string, name: string): Promise<any>;
  insert(doctype: string, doc: Record<string, unknown>): Promise<any>;
  call(method: string, args: Record<string, unknown>): Promise<any>;
}

const SITE_KEY = /^[A-Z][A-Z0-9_]{1,31}$/;

/** Strips HTML and keeps a short, log-safe Frappe message for conflict detection. */
function serverMessage(body: any): string | null {
  const parts: string[] = [];
  if (typeof body?.exception === 'string') parts.push(body.exception);
  if (typeof body?._server_messages === 'string') {
    try {
      for (const raw of JSON.parse(body._server_messages)) {
        const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (typeof item?.message === 'string') parts.push(item.message);
      }
    } catch { /* message is optional */ }
  }
  const text = parts.join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 1000) : null;
}

export function frappeSite(key: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): FrappeSite {
  if (!SITE_KEY.test(key)) throw new FrappeSiteError('SITE_NOT_CONFIGURED');
  const prefix = `MARKETPLACE_FRAPPE_${key}_`;
  const origin = env[prefix + 'URL'];
  const apiKey = env[prefix + 'API_KEY'];
  const apiSecret = env[prefix + 'API_SECRET'];
  if (!origin || !apiKey || !apiSecret) throw new FrappeSiteError('SITE_NOT_CONFIGURED');
  let base: URL;
  try { base = new URL(origin); } catch { throw new FrappeSiteError('SITE_NOT_CONFIGURED'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new FrappeSiteError('SITE_NOT_CONFIGURED');
  // Plain HTTP only inside the cluster or for local tests.
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(base.hostname) && !base.hostname.endsWith('.svc.cluster.local'))
    throw new FrappeSiteError('SITE_NOT_CONFIGURED');

  const run = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> => {
    let res: Response;
    try {
      res = await fetchImpl(new URL(path, base), {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `token ${apiKey}:${apiSecret}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
    } catch {
      throw new FrappeSiteError('SITE_UNAVAILABLE');
    }
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      // 5xx/429: the site is down, in its reset window or throttling; 401: our
      // service token is wrong. None of these is the visitor's fault.
      if (res.status >= 500 || res.status === 429 || res.status === 401)
        throw new FrappeSiteError('SITE_UNAVAILABLE', res.status, data?.exc_type ?? null, serverMessage(data));
      throw new FrappeSiteError('SITE_REJECTED', res.status, data?.exc_type ?? null, serverMessage(data));
    }
    return data?.message ?? data?.data ?? data;
  };
  const resource = (doctype: string) => '/api/resource/' + encodeURIComponent(doctype);
  return {
    key,
    host: base.hostname,
    list: (doctype, filters, fields, limit = 500) => {
      const q = new URLSearchParams({ filters: JSON.stringify(filters), fields: JSON.stringify(fields), limit_page_length: String(limit) });
      return run('GET', resource(doctype) + '?' + q);
    },
    get: (doctype, name) => run('GET', resource(doctype) + '/' + encodeURIComponent(name)),
    insert: (doctype, doc) => run('POST', resource(doctype), { doctype, ...doc }),
    call: async (method, args) => {
      if (!/^[a-z_][a-z0-9_.]+$/.test(method)) throw new FrappeSiteError('SITE_NOT_CONFIGURED');
      return run('POST', '/api/method/' + method, args);
    },
  };
}
