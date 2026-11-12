import { vi } from 'vitest';

/** Explicit local fixtures, never a flag for a shared API/worker Deployment. */
export function enableIsolatedPawaPaySandbox(): void {
  vi.stubEnv('PAWAPAY_ALLOW_SANDBOX', 'true');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', process.env.DATABASE_URL ?? 'postgres://localhost:5432/konektag_test');
  vi.stubEnv('API_PUBLIC_URL', 'http://api.test');
  vi.stubEnv('PUBLIC_SITE_URL', 'http://web.test');
  vi.stubEnv('ERPNEXT_URL', 'http://frappe.test');
}
