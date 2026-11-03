/**
 * ERPNext REST API client for Node.js backend.
 * Communicates with the ERPNext Docker container via REST API.
 * Uses a Frappe API token for authentication (server-side only, never exposed).
 */

const ERPNEXT_URL = process.env.ERPNEXT_URL;
if (!ERPNEXT_URL) {
  throw new Error('[ERPNext] ERPNEXT_URL environment variable is required but not set');
}

const FRAPPE_API_KEY = process.env.FRAPPE_API_KEY;
if (!FRAPPE_API_KEY) {
  throw new Error('[ERPNext] FRAPPE_API_KEY environment variable is required but not set');
}

const FRAPPE_API_SECRET = process.env.FRAPPE_API_SECRET;
if (!FRAPPE_API_SECRET) {
  throw new Error('[ERPNext] FRAPPE_API_SECRET environment variable is required but not set');
}

interface ERPNextResponse {
  data?: any;
  message?: any;
  _server_messages?: string;
}

async function request(method: string, path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `token ${FRAPPE_API_KEY}:${FRAPPE_API_SECRET}`,
  };

  const opts: RequestInit = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const url = `${ERPNEXT_URL}${path}`;
  const res = await fetch(url, opts);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ERPNext ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json().then((d: ERPNextResponse) => d.data ?? d.message ?? d);
}

export const erpnext = {
  /** Invoke an authenticated Frappe method using the site's existing ERPNext credentials. */
  callMethod(method: string, args: Record<string, unknown>) {
    if (!/^[a-zA-Z_][a-zA-Z_0-9]*(\.[a-zA-Z_][a-zA-Z_0-9]*)+$/.test(method)) {
      throw new Error('Invalid ERPNext method');
    }
    return request('POST', `/api/method/${method}`, args);
  },

  /** Frappe REST resource filters, without a custom Python API. */
  query(doctype: string, filters: Array<[string, string, unknown]>, fields: string[], limit = 500) {
    const params = new URLSearchParams();
    params.set('filters', JSON.stringify(filters));
    params.set('fields', JSON.stringify(fields));
    params.set('limit_page_length', String(limit));
    return request('GET', `/api/resource/${encodeURIComponent(doctype)}?${params}`);
  },

  get(doctype: string, name: string) {
    return request('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  },

  list(doctype: string, filters?: Record<string, any>, fields?: string[], limit = 50) {
    const params = new URLSearchParams();
    params.set('limit_page_length', String(limit));
    if (filters && Object.keys(filters).length > 0) {
      const f = Object.entries(filters).map(([k, v]) => [doctype, k, '=', v]);
      params.set('filters', JSON.stringify(f));
    }
    if (fields) params.set('fields', JSON.stringify(fields));
    return request('GET', `/api/resource/${encodeURIComponent(doctype)}?${params}`);
  },

  listAdvanced(doctype: string, opts?: {
    filters?: Record<string, any>;
    fields?: string[];
    limit?: number;
    offset?: number;
    orderBy?: string;
    searchText?: string;
  }) {
    const params = new URLSearchParams();
    const limit = opts?.limit ?? 50;
    params.set('limit_page_length', String(limit));
    if (opts?.offset) params.set('limit_start', String(opts.offset));
    if (opts?.orderBy) params.set('order_by', opts.orderBy);
    if (opts?.searchText) params.set('search_text', opts.searchText);
    if (opts?.filters && Object.keys(opts.filters).length > 0) {
      const f = Object.entries(opts.filters).map(([k, v]) => [doctype, k, '=', v]);
      params.set('filters', JSON.stringify(f));
    }
    if (opts?.fields) params.set('fields', JSON.stringify(opts.fields));
    return request('GET', `/api/resource/${encodeURIComponent(doctype)}?${params}`);
  },

  create(doctype: string, doc: Record<string, any>) {
    return request('POST', `/api/resource/${encodeURIComponent(doctype)}`, { doctype, ...doc });
  },

  update(doctype: string, name: string, doc: Record<string, any>) {
    return request('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, doc);
  },

  delete(doctype: string, name: string) {
    return request('DELETE', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  },

  exists(doctype: string, field: string, value: string): Promise<boolean> {
    return request('GET', `/api/resource/${encodeURIComponent(doctype)}?filters=${encodeURIComponent(JSON.stringify([[doctype, field, '=', value]]))}&limit=1&fields=${encodeURIComponent(JSON.stringify(['name']))}`)
      .then(d => (Array.isArray(d) ? d.length > 0 : !!d));
  },

  submit(doctype: string, name: string) {
    // PUT with docstatus=1 is the most reliable way to submit in ERPNext v15
    return request('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, { docstatus: 1 });
  },

  cancel(doctype: string, name: string) {
    return request('POST', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}/cancel`);
  },
};
