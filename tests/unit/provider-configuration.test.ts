import { afterEach, describe, expect, it } from 'vitest';
import { ProviderConfigurationError, resolvePawaPayConfiguration, resolveStripeConfiguration } from '../../src/infrastructure/adapters/provider-configuration.ts';

const keys = [
  'KTG_FR_STRIPE_TEST_SECRET_KEY', 'KTG_FR_STRIPE_TEST_PUBLISHABLE_KEY',
  'KTG_FR_STRIPE_LIVE_SECRET_KEY', 'KTG_FR_STRIPE_LIVE_PUBLISHABLE_KEY',
  'KTG_CG_PAWAPAY_SANDBOX_API_URL', 'KTG_CG_PAWAPAY_SANDBOX_API_TOKEN',
  'KTG_CG_PAWAPAY_LIVE_API_URL', 'KTG_CG_PAWAPAY_LIVE_API_TOKEN',
] as const;

afterEach(() => { for (const key of keys) delete process.env[key]; });

describe('provider configuration resolution', () => {
  it('resolves distinct Stripe credentials from logical configuration keys', () => {
    process.env.KTG_FR_STRIPE_TEST_SECRET_KEY = 'sk_test_a';
    process.env.KTG_FR_STRIPE_TEST_PUBLISHABLE_KEY = 'pk_test_a';
    process.env.KTG_FR_STRIPE_LIVE_SECRET_KEY = 'sk_live_b';
    process.env.KTG_FR_STRIPE_LIVE_PUBLISHABLE_KEY = 'pk_live_b';
    expect(resolveStripeConfiguration('KTG_FR_STRIPE_TEST')).toMatchObject({ key: 'KTG_FR_STRIPE_TEST', secretKey: 'sk_test_a', publishableKey: 'pk_test_a' });
    expect(resolveStripeConfiguration('KTG_FR_STRIPE_LIVE')).toMatchObject({ key: 'KTG_FR_STRIPE_LIVE', secretKey: 'sk_live_b', publishableKey: 'pk_live_b' });
  });

  it('resolves distinct PawaPay credentials from logical configuration keys', () => {
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_URL = 'https://api.sandbox.pawapay.io/';
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_TOKEN = 'sandbox-token';
    process.env.KTG_CG_PAWAPAY_LIVE_API_URL = 'https://api.pawapay.io';
    process.env.KTG_CG_PAWAPAY_LIVE_API_TOKEN = 'live-token';
    expect(resolvePawaPayConfiguration('KTG_CG_PAWAPAY_SANDBOX')).toMatchObject({ key: 'KTG_CG_PAWAPAY_SANDBOX', apiUrl: 'https://api.sandbox.pawapay.io', apiToken: 'sandbox-token' });
    expect(resolvePawaPayConfiguration('KTG_CG_PAWAPAY_LIVE')).toMatchObject({ key: 'KTG_CG_PAWAPAY_LIVE', apiUrl: 'https://api.pawapay.io', apiToken: 'live-token' });
  });

  it('rejects arbitrary environment variable names and cross-provider keys', () => {
    expect(() => resolveStripeConfiguration('DATABASE_URL')).toThrow(ProviderConfigurationError);
    expect(() => resolveStripeConfiguration('KTG_CG_PAWAPAY_SANDBOX')).toThrow(ProviderConfigurationError);
    expect(() => resolvePawaPayConfiguration('KTG_FR_STRIPE_TEST')).toThrow(ProviderConfigurationError);
  });

  it.each([
    ['KTG_CG_PAWAPAY_SANDBOX', 'https://api.pawapay.io'],
    ['KTG_CG_PAWAPAY_LIVE', 'https://api.sandbox.pawapay.io'],
    ['KTG_CG_PAWAPAY_SANDBOX', 'http://api.sandbox.pawapay.io'],
    ['KTG_CG_PAWAPAY_SANDBOX', 'https://api.sandbox.pawapay.io/other'],
    ['KTG_CG_PAWAPAY_SANDBOX', 'https://user:password@api.sandbox.pawapay.io'],
  ])('rejects an inconsistent or unsafe host for %s', (key, url) => {
    process.env[`${key}_API_URL`] = url;
    process.env[`${key}_API_TOKEN`] = 'local-test-token';
    expect(() => resolvePawaPayConfiguration(key)).toThrow(ProviderConfigurationError);
  });
});
