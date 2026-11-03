export interface MauticContactData {
  konektag_user_id?: string;
  email?: string;
  firstname?: string;
  lastname?: string;
  preferred_locale?: string;
  country?: string;
  konektag_marketing_opt_in?: boolean;
}

export interface MauticContactResult {
  id: number;
  [key: string]: unknown;
}

const BASE_URL = process.env.MAUTIC_BASE_URL || 'https://marketing.konektag.eu';
const CLIENT_ID = process.env.MAUTIC_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.MAUTIC_OAUTH_CLIENT_SECRET || '';
const TIMEOUT_MS = 15_000;

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }

  const res = await fetch(`${BASE_URL}/oauth/v2/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mautic OAuth failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 60_000,
  };
  return cachedToken.access_token;
}

async function mauticFetch(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const token = await getToken();
  const url = `${BASE_URL}/api/${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await res.json();

    if (!res.ok) {
      const errMsg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
      throw new Error(`Mautic ${method} ${path}: ${errMsg}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// A03: exact, unique lookup only. The existing findByEmail helper is deliberately
// not reused: it may select a contact by preference instead of strict identity.
function contactEmail(contact: any): string {
  const value = contact?.fields?.all?.email
    ?? contact?.fields?.core?.email?.value
    ?? contact?.email;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function contactTags(contact: any): string[] {
  const values = contact?.tags;
  if (!values || typeof values !== 'object') return [];
  return Object.values(values).map((tag: any) =>
    typeof tag === 'string' ? tag : String(tag?.tag ?? '')
  );
}

export const mauticAdapter = {
  /**
   * A03 Digital Audit: add-only tag on exactly one existing Contact.
   * Never create a Contact, alter other tags, DNC, segments or campaign assets.
   * A missing match is legitimate (an organic audit request), but ambiguous or
   * incomplete Mautic searches fail closed and are retried via the outbox.
   */
  async markAuditRequestedByEmail(email: string): Promise<'tagged' | 'not_found'> {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) throw new Error('MAUTIC_AUDIT_EMAIL_INVALID');
    if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('MAUTIC_AUDIT_OAUTH_CONFIG_MISSING');

    try {
      const search = new URLSearchParams({
        search: `!email:${normalized}`,
        limit: '100',
        start: '0',
      });
      const data = await mauticFetch('GET', `contacts?${search.toString()}`);
      const source = data?.contacts;
      if (!source || typeof source !== 'object') {
        throw new Error('MAUTIC_AUDIT_CONTACTS_INVALID');
      }
      const rows = Object.values(source) as any[];
      const total = Number(data?.total);
      if (!Number.isSafeInteger(total) || total < rows.length || total > rows.length) {
        throw new Error('MAUTIC_AUDIT_CONTACTS_INCOMPLETE');
      }
      const exact = rows.filter(contact => contactEmail(contact) === normalized);
      if (exact.length > 1) throw new Error('MAUTIC_AUDIT_EMAIL_AMBIGUOUS');
      if (!exact.length) return 'not_found';

      const contact = exact[0];
      if (!Number.isSafeInteger(Number(contact.id)) || Number(contact.id) < 1) {
        throw new Error('MAUTIC_AUDIT_CONTACT_ID_INVALID');
      }
      if (!contactTags(contact).includes('audit_requested')) {
        // PATCH tag syntax is additive in Mautic 7.1: other tags remain intact.
        await mauticFetch('PATCH', `contacts/${contact.id}/edit`, {
          tags: ['audit_requested'],
        });
      }
      return 'tagged';
    } catch (error) {
      // The outbox stores/logs only stable codes, never emails or OAuth details.
      const code = (error as Error).message;
      if (code === 'MAUTIC_AUDIT_EMAIL_AMBIGUOUS' ||
          code === 'MAUTIC_AUDIT_CONTACTS_INCOMPLETE' ||
          code === 'MAUTIC_AUDIT_CONTACTS_INVALID' ||
          code === 'MAUTIC_AUDIT_CONTACT_ID_INVALID') {
        throw error;
      }
      throw new Error('MAUTIC_AUDIT_DELIVERY_FAILED');
    }
  },
  async findByKonektagUserId(id: string): Promise<MauticContactResult | null> {
    const data = await mauticFetch(
      'GET',
      `/contacts?search=${encodeURIComponent(`!konektag_user_id:${id}`)}`,
    );
    const contacts = data?.contacts || [];
    const keys = Object.keys(contacts);
    if (keys.length === 0) return null;
    return contacts[keys[0]] || null;
  },

  async findByEmail(email: string): Promise<MauticContactResult | null> {
    const data = await mauticFetch(
      'GET',
      `/contacts?search=${encodeURIComponent(`!email:${email}`)}`,
    );
    const contacts = data?.contacts || [];
    const keys = Object.keys(contacts);
    if (keys.length === 0) return null;

    for (const key of keys) {
      const c = contacts[key];
      const existingId = c.fields?.core?.konektag_user_id?.value;
      if (!existingId) return c;
    }
    return contacts[keys[0]] || null;
  },

  async create(data: MauticContactData): Promise<MauticContactResult> {
    const result = await mauticFetch('POST', 'contacts/new', { ...data });
    return result.contact;
  },

  async update(id: number, data: Partial<MauticContactData>): Promise<MauticContactResult> {
    const result = await mauticFetch('PATCH', `contacts/${id}/edit`, { ...data });
    return result.contact;
  },

  async findCompanyByMerchantId(merchantId: string): Promise<{ id: number } | null> {
    const data = await mauticFetch(
      'GET',
      `/companies?search=${encodeURIComponent(`!konektag_merchant_id:${merchantId}`)}`,
    );
    const companies = data?.companies || [];
    const keys = Object.keys(companies);
    if (keys.length === 0) return null;
    return companies[keys[0]] || null;
  },

  async createCompany(data: Record<string, unknown>): Promise<any> {
    const result = await mauticFetch('POST', 'companies/new', data);
    return result.company;
  },

  async updateCompany(id: number, data: Record<string, unknown>): Promise<any> {
    const result = await mauticFetch('PATCH', `companies/${id}/edit`, data);
    return result.company;
  },

  async upsertCompany(data: Record<string, unknown>): Promise<{ contact: any; created: boolean }> {
    const merchantId = data.konektag_merchant_id as string;
    if (merchantId) {
      const existing = await mauticAdapter.findCompanyByMerchantId(merchantId);
      if (existing) {
        const updated = await mauticAdapter.updateCompany(existing.id, data);
        return { contact: updated, created: false };
      }
    }
    const created = await mauticAdapter.createCompany(data);
    return { contact: created, created: true };
  },

  async associateContactToCompany(keycloakId: string, companyId: number): Promise<void> {
    const contact = await mauticAdapter.findByKonektagUserId(keycloakId);
    if (!contact) {
      console.error(`[Mautic] Contact not found for keycloak_id ${keycloakId}, cannot associate`);
      return;
    }
    await mauticFetch('POST', `companies/${companyId}/contact/${contact.id}/add`);
  },

  async removeContactFromCompany(keycloakId: string, companyId: number): Promise<void> {
    const contact = await mauticAdapter.findByKonektagUserId(keycloakId);
    if (!contact) return;
    await mauticFetch('POST', `companies/${companyId}/contact/${contact.id}/remove`).catch((err: Error) => {
      if (err.message.includes('404')) return;
      throw err;
    });
  },

  async upsert(data: MauticContactData): Promise<{ contact: MauticContactResult; created: boolean }> {
    if (data.konektag_user_id) {
      const existing = await mauticAdapter.findByKonektagUserId(data.konektag_user_id);
      if (existing) {
        const updated = await mauticAdapter.update(existing.id, data);
        return { contact: updated, created: false };
      }
    }

    if (data.email) {
      const existing = await mauticAdapter.findByEmail(data.email);
      if (existing) {
        const updated = await mauticAdapter.update(existing.id, data);
        return { contact: updated, created: false };
      }
    }

    const created = await mauticAdapter.create(data);
    return { contact: created, created: true };
  },
};
