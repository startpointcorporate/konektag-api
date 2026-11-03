export class ProviderConfigurationError extends Error {}

export type StripeProviderConfiguration = {
  provider: 'stripe';
  key: string;
  secretKey: string;
  publishableKey: string;
  webhookSecret?: string;
};

export type PawaPayProviderConfiguration = {
  provider: 'pawapay';
  key: string;
  apiUrl: string;
  apiToken: string;
};

const KEY_PATTERNS = {
  stripe: /^KTG_[A-Z0-9]+_STRIPE_(TEST|LIVE)$/,
  pawapay: /^KTG_[A-Z0-9]+_PAWAPAY_(SANDBOX|LIVE)$/,
} as const;

export function assertProviderConfigurationKey(provider: string, key: string): void {
  const pattern = KEY_PATTERNS[provider as keyof typeof KEY_PATTERNS];
  if (!pattern || !pattern.test(key)) throw new ProviderConfigurationError(`Invalid ${provider} provider configuration key`);
}

function name(key: string, suffix: string): string {
  return `${key}_${suffix}`;
}

function required(key: string, suffix: string): string {
  const value = process.env[name(key, suffix)];
  if (!value) throw new ProviderConfigurationError(`Provider configuration ${key} is incomplete`);
  return value;
}

// Existing payment requests predate provider_configuration_key. Their explicitly
// scoped fallback preserves settlement while new requests always use a logical key.
function legacyStripe(): StripeProviderConfiguration {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLIC_KEY;
  if (!secretKey || !publishableKey) throw new ProviderConfigurationError('Legacy Stripe configuration is incomplete');
  return { provider: 'stripe', key: 'LEGACY_STRIPE', secretKey, publishableKey, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET };
}

function legacyPawaPay(): PawaPayProviderConfiguration {
  const apiUrl = process.env.PAWAPAY_API_URL;
  const apiToken = process.env.PAWAPAY_API_TOKEN;
  if (!apiUrl || !apiToken) throw new ProviderConfigurationError('Legacy PawaPay configuration is incomplete');
  return { provider: 'pawapay', key: 'LEGACY_PAWAPAY', apiUrl: apiUrl.replace(/\/$/, ''), apiToken };
}

export function resolveStripeConfiguration(key: string | null): StripeProviderConfiguration {
  if (!key) return legacyStripe();
  assertProviderConfigurationKey('stripe', key);
  return {
    provider: 'stripe', key,
    secretKey: required(key, 'SECRET_KEY'),
    publishableKey: required(key, 'PUBLISHABLE_KEY'),
    webhookSecret: process.env[name(key, 'WEBHOOK_SECRET')],
  };
}

export function resolvePawaPayConfiguration(key: string | null): PawaPayProviderConfiguration {
  if (!key) return legacyPawaPay();
  assertProviderConfigurationKey('pawapay', key);
  return { provider: 'pawapay', key, apiUrl: required(key, 'API_URL').replace(/\/$/, ''), apiToken: required(key, 'API_TOKEN') };
}
