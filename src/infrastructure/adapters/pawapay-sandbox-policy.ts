/** One policy for API processes, callback consumers and reconciliation workers. */
export class PawaPaySandboxPolicyError extends Error {
  readonly code = 'PAWAPAY_SANDBOX_DISABLED';
  constructor() { super('PawaPay sandbox financial operations require an isolated test runtime'); }
}

function testUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'postgres:', 'postgresql:'].includes(url.protocol)
      && !url.username && !url.password
      && (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.hostname.endsWith('.test') || url.hostname.endsWith('.localhost')
        || /(?:^|[.-])(?:sandbox|test)(?:[.-]|$)/.test(url.hostname));
  } catch { return false; }
}

export function assertPawaPayFinancialOperation(key: string | null): void {
  const apiUrl = key ? process.env[`${key}_API_URL`] : process.env.PAWAPAY_API_URL;
  const sandbox = key?.endsWith('_PAWAPAY_SANDBOX')
    || (apiUrl && new URL(apiUrl).hostname === 'api.sandbox.pawapay.io');
  if (!sandbox) return; // Preserve existing live and unconfigured legacy paths.

  const refuse = () => { throw new PawaPaySandboxPolicyError(); };
  if (process.env.PAWAPAY_ALLOW_SANDBOX !== 'true' || process.env.NODE_ENV !== 'test') refuse();
  try {
    const db = new URL(process.env.DATABASE_URL ?? '');
    // Never reuse the shared business database, even for an order marked live.
    if (db.pathname !== '/konektag_test' || !testUrl(`${db.protocol}//${db.host}`)) refuse();
  } catch { refuse(); }
  if (!testUrl(process.env.API_PUBLIC_URL ?? '')) refuse();
  if (process.env.PUBLIC_SITE_URL && !testUrl(process.env.PUBLIC_SITE_URL)) refuse();

  const frappeUrls = Object.entries(process.env)
    .filter(([name, value]) => value && /(?:FRAPPE|ERPNEXT).*URL$/.test(name))
    .map(([, value]) => value!);
  // Site registries may carry additional ERPNext endpoints.
  if (process.env.LINK_PAY_FRAPPE_SITES) {
    try {
      const walk = (value: unknown): void => {
        if (typeof value === 'string' && /^https?:\/\//.test(value)) frappeUrls.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(JSON.parse(process.env.LINK_PAY_FRAPPE_SITES));
    } catch { refuse(); }
  }
  if (!frappeUrls.length || frappeUrls.some(url => !testUrl(url))) refuse();
}
