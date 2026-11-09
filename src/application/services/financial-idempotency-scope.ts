import crypto from 'node:crypto';

export const FINANCIAL_ROUTE_KEYS = {
  '/api/webhooks/stripe': 'K_ACQUISITION_STRIPE_CONFIRM',
  '/api/qr/': 'QR_CONSUMPTION_CONFIRM',
  '/api/pay/': 'LINK_CONSUMPTION_CONFIRM',
  '/api/cards/': 'K_VOUCHER_ACTIVATE',
  '/api/admin/merchant-settlements/': 'MERCHANT_SETTLEMENT',
  '/api/admin/clearing/': 'CLEARING_APPROVE',
  '/api/admin/recharges/': 'REFUND_CREATE',
  '/api/admin/interco/': 'INTERCOMPANY_SETTLEMENT',
} as const;

export type FinancialRouteKey = typeof FINANCIAL_ROUTE_KEYS[keyof typeof FINANCIAL_ROUTE_KEYS];

export function resolveFinancialRouteKey(pathname: string): FinancialRouteKey | null {
  // Issuing/reading a personal receive capability does not move K and must not
  // enter financial idempotency/legal-entity scoping. The actual K send is
  // protected at confirmation/sendPointsK time.
  const normalized = pathname.replace(/\/+$/, '');
  if (
    normalized === '/api/qr/personal-link'
    || normalized === '/api/qr/request-confirmation'
    || normalized === '/api/k/send'
    || normalized.startsWith('/api/k/send/')
    || normalized === '/api/pay/payment-links'
    || normalized === '/api/pay/pay-link'
    || normalized === '/api/pay/web/pay-link'
    || /^\/api\/pay\/payment-links\/[^/]+\/resume$/.test(normalized)
  ) return null;
  const match = Object.entries(FINANCIAL_ROUTE_KEYS).find(([prefix]) => pathname === prefix || pathname.startsWith(prefix));
  return match?.[1] ?? null;
}

// Wallet recharge is merchantless. Its settlement legal entity is frozen by the
// selected Payment Context after checkout, so it cannot scope idempotency by one.
export function requiresLegalEntityScope(pathname: string): boolean {
  const normalized=pathname.replace(/\/+$/, '');
  if (
    normalized === '/api/qr/request-confirmation'
    || normalized === '/api/k/send'
    || normalized.startsWith('/api/k/send/')
    || normalized === '/api/pay/pay-link'
    || normalized === '/api/pay/web/pay-link'
    || /^\/api\/pay\/payment-links\/[^/]+\/resume$/.test(normalized)
  ) return false;
  return normalized !== '/api/pay/recharges';
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}

export function financialRequestFingerprint(routeKey: FinancialRouteKey, actorType: string, actorId: string, legalEntityId: string, rawBody: string): string {
  let payload: unknown = rawBody;
  try { payload = normalize(JSON.parse(rawBody)); } catch { /* raw non-JSON payload remains deterministic */ }
  return crypto.createHash('sha256').update(JSON.stringify({ routeKey, actorType, actorId, legalEntityId, payload })).digest('hex');
}
