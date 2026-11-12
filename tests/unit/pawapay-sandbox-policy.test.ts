import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPawaPayFinancialOperation, PawaPaySandboxPolicyError } from '../../src/infrastructure/adapters/pawapay-sandbox-policy.ts';
import { enableIsolatedPawaPaySandbox } from '../helpers/pawapay-sandbox-runtime.ts';

afterEach(() => vi.unstubAllEnvs());
describe('PawaPay sandbox financial isolation', () => {
  const sandbox = 'KTG_CG_PAWAPAY_SANDBOX';
  it('is disabled by default', () => {
    vi.stubEnv('PAWAPAY_ALLOW_SANDBOX', undefined);
    expect(() => assertPawaPayFinancialOperation(sandbox)).toThrow(PawaPaySandboxPolicyError);
  });
  it('preserves live behavior', () => {
    expect(() => assertPawaPayFinancialOperation('KTG_CG_PAWAPAY_LIVE')).not.toThrow();
  });
  it('allows an explicitly isolated test runtime', () => {
    enableIsolatedPawaPaySandbox();
    expect(() => assertPawaPayFinancialOperation(sandbox)).not.toThrow();
  });
  it.each([
    ['NODE_ENV', 'production'], ['DATABASE_URL', 'postgres://localhost:5432/konektag'],
    ['DATABASE_URL', 'postgres://production-db:5432/konektag_test'],
    ['API_PUBLIC_URL', 'https://api.konektag.eu'], ['PUBLIC_SITE_URL', 'https://www.konektag.eu'],
    ['ERPNEXT_URL', 'https://erpnext.konektag.eu'],
    ['LINK_PAY_FRAPPE_SITES', '{"CG":{"baseUrl":"https://erpnext.konektag.eu"}}'],
  ])('refuses a shared runtime setting %s even with the flag enabled', (name, value) => {
    enableIsolatedPawaPaySandbox(); vi.stubEnv(name, value);
    expect(() => assertPawaPayFinancialOperation(sandbox)).toThrow(PawaPaySandboxPolicyError);
  });
  it('also protects the legacy sandbox URL', () => {
    vi.stubEnv('PAWAPAY_API_URL', 'https://api.sandbox.pawapay.io');
    vi.stubEnv('PAWAPAY_ALLOW_SANDBOX', undefined);
    expect(() => assertPawaPayFinancialOperation(null)).toThrow(PawaPaySandboxPolicyError);
  });
});
