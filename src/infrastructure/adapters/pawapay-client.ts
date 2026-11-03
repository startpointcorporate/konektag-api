import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { resolvePawaPayConfiguration, type PawaPayProviderConfiguration } from './provider-configuration.ts';

export class PawaPayError extends Error {}

export type PawaPayDepositStatus = 'ACCEPTED' | 'PROCESSING' | 'IN_RECONCILIATION' | 'COMPLETED' | 'FAILED';
export interface PawaPayDeposit {
  depositId: string;
  status: PawaPayDepositStatus;
  amount: string;
  currency: string;
  failureReason?: string;
}

export interface PawaPayCheckout {
  checkoutId: string;
  status: string;
  depositId?: string | null;
}
export interface PawaPayPaymentPageInput {
  depositId: string;
  returnUrl: string;
  amount: number;
  currency: string;
  country: 'CMR' | 'COG' | 'GAB';
  reason: string;
  metadata: Array<Record<string, string | boolean>>;
}

type PawaPayPublicKey = { id: string; key: string };
type SignatureInput = { label: string; components: string[]; params: string; keyId: string; algorithm: string; created: number; expires: number };

const KEY_CACHE_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_SECONDS = Number(process.env.PAWAPAY_SIGNATURE_CLOCK_SKEW_SECONDS ?? 60);
let keyCache: PawaPayPublicKey[] = [];
let keyCacheExpiresAt = 0;

function configuration(key?: string | null): PawaPayProviderConfiguration {
  try { return resolvePawaPayConfiguration(key ?? null); }
  catch { throw new PawaPayError('PawaPay is not configured'); }
}

async function api<T>(path: string, init?: RequestInit, key?: string | null): Promise<T> {
  const config = configuration(key);
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.apiToken}`, Accept: 'application/json', ...init?.headers },
  });
  if (!response.ok) throw new PawaPayError(`PawaPay request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export function toPawaPayAmount(currency: string, amount: number): string {
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(amount) || amount <= 0) throw new PawaPayError('Invalid canonical amount');
  return String(amount);
}

export function fromPawaPayAmount(currency: string, amount: unknown): number {
  if (!/^[A-Z]{3}$/.test(currency) || typeof amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) {
    throw new PawaPayError('Invalid PawaPay amount');
  }
  // PawaPay serializes amounts with decimal scale (for example "9000.00")
  // even for zero-decimal currencies such as XAF/XOF. Our checkout domain
  // stores whole currency units, so accept a decimal representation only when
  // its fractional component is exactly zero. Never round a real fraction.
  const parsed = Number(amount);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PawaPayError(`PawaPay amount is not representable for ${currency}`);
  }
  return parsed;
}

export const pawaPayClient = {
  async predictCorrespondent(phoneNumber: string): Promise<string> {
    const response = await api<{ correspondent?: string }>('/v2/predict-correspondent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payer: { type: 'MSISDN', address: { value: phoneNumber } } }),
    });
    if (typeof response.correspondent !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(response.correspondent)) {
      throw new PawaPayError('PawaPay did not return a valid correspondent');
    }
    return response.correspondent;
  },
  async createDeposit(input: { depositId: string; phoneNumber: string; correspondent: string; amount: number; currency: string; statementDescription: string }) {
    const response = await api<{ status?: string }>('/v2/deposits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositId: input.depositId, amount: toPawaPayAmount(input.currency, input.amount), currency: input.currency, correspondent: input.correspondent, payer: { type: 'MSISDN', address: { value: input.phoneNumber } }, customerTimestamp: new Date().toISOString(), statementDescription: input.statementDescription }),
    });
    if (!response.status || !['ACCEPTED', 'DUPLICATE_IGNORED', 'REJECTED'].includes(response.status)) throw new PawaPayError('Invalid PawaPay deposit initiation response');
    return response.status as 'ACCEPTED' | 'DUPLICATE_IGNORED' | 'REJECTED';
  },
  async createPaymentPage(input: PawaPayPaymentPageInput & { providerConfigurationKey: string | null }): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.depositId)) {
      throw new PawaPayError('depositId must be a UUIDv4');
    }
    if (!/^https:\/\//.test(input.returnUrl) || input.reason.length < 1 || input.reason.length > 50 || input.metadata.length > 10) {
      throw new PawaPayError('Invalid PawaPay Payment Page request');
    }
    const response = await api<{ redirectUrl?: unknown }>('/v2/paymentpage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        depositId: input.depositId,
        returnUrl: input.returnUrl,
        amountDetails: { amount: toPawaPayAmount(input.currency, input.amount), currency: input.currency },
        country: input.country,
        reason: input.reason,
        metadata: input.metadata,
      }),
    }, input.providerConfigurationKey);
    if (typeof response.redirectUrl !== 'string' || !/^https:\/\//.test(response.redirectUrl)) {
      throw new PawaPayError('PawaPay did not return a valid redirectUrl');
    }
    console.log('[pawapay-payment-page] created', {
      depositId: input.depositId,
      country: input.country,
      currency: input.currency,
      amount: input.amount,
      redirectHost: new URL(response.redirectUrl).host,
    });
    return response.redirectUrl;
  },
  async getCheckout(checkoutId: string, providerConfigurationKey?: string | null): Promise<PawaPayCheckout> {
    const response = await api<any>(`/v2/checkouts/${encodeURIComponent(checkoutId)}`, undefined, providerConfigurationKey);
    const data = response?.data ?? response;
    const id = data?.checkoutId ?? data?.depositId ?? checkoutId;
    const status = data?.status ?? response?.status;
    const depositId = data?.depositId ?? data?.deposit?.depositId ?? data?.payment?.depositId ?? null;
    if (typeof status !== 'string') throw new PawaPayError('Invalid PawaPay checkout status response');
    return { checkoutId: String(id), status, depositId: typeof depositId === 'string' ? depositId : null };
  },
  async getDeposit(depositId: string, providerConfigurationKey?: string | null): Promise<PawaPayDeposit> {
    const response = await api<{ status?: string; data?: PawaPayDeposit }>(`/v2/deposits/${encodeURIComponent(depositId)}`, undefined, providerConfigurationKey);
    if (response.status !== 'FOUND' || !response.data) throw new PawaPayError(`PawaPay deposit ${response.status ?? 'UNKNOWN'}`);
    return response.data;
  },
  activeConfiguration() { return api<unknown>('/v2/active-conf'); },
  publicKeys(providerConfigurationKey?: string | null) { return api<PawaPayPublicKey[]>('/v2/public-key/http', undefined, providerConfigurationKey); },
};

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) throw new PawaPayError(`Missing ${name}`);
  return value;
}

function parseSignatureInput(value: string): SignatureInput {
  const match = /^([A-Za-z0-9_-]+)=\(([^)]*)\)((?:;[A-Za-z0-9_-]+=(?:"[^"]*"|[^;]+))+)\s*$/.exec(value);
  if (!match) throw new PawaPayError('Invalid Signature-Input');
  const components = [...match[2].matchAll(/"([^"]+)"/g)].map(([, component]) => component);
  if (!components.length) throw new PawaPayError('Invalid Signature-Input');
  const params = new Map([...match[3].matchAll(/;([A-Za-z0-9_-]+)=("[^"]*"|[^;]+)/g)].map(([, key, raw]) => [key, raw.replace(/^"|"$/g, '')]));
  const keyId = params.get('keyid'); const algorithm = params.get('alg'); const created = Number(params.get('created')); const expires = Number(params.get('expires'));
  if (!keyId || !algorithm || !Number.isSafeInteger(created) || !Number.isSafeInteger(expires)) throw new PawaPayError('Invalid Signature-Input parameters');
  return { label: match[1], components, params: match[3], keyId, algorithm, created, expires };
}

function signatureValue(signature: string, label: string): Buffer {
  const match = new RegExp(`(?:^|,\\s*)${label}=:(.+?):(?:,|$)`).exec(signature);
  if (!match) throw new PawaPayError('Missing signature value');
  return Buffer.from(match[1], 'base64');
}

function signatureComponent(request: Request, component: string): string {
  if (component === '@method') return request.method.toUpperCase();
  if (component === '@authority') return new URL(request.url).host;
  if (component === '@path') { const url = new URL(request.url); return `${url.pathname}${url.search}`; }
  return requiredHeader(request, component);
}

export function pawaPaySignatureBase(request: Request, input: SignatureInput): string {
  const lines = input.components.map(component => `"${component}": ${signatureComponent(request, component)}`);
  lines.push(`"@signature-params": (${input.components.map(component => `"${component}"`).join(' ')})${input.params}`);
  return lines.join('\n');
}

function verifyDigest(rawBody: string, digest: string): void {
  const match = /^(sha-256|sha-512)=:([A-Za-z0-9+/]+={0,2}):$/.exec(digest);
  if (!match) throw new PawaPayError('Invalid Content-Digest');
  const actual = `${match[1]}=:${createHash(match[1].replace('-', '')).update(rawBody).digest('base64')}:`;
  if (actual.length !== digest.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(digest))) throw new PawaPayError('Invalid Content-Digest');
}

async function publicKey(keyId: string, providerConfigurationKey?: string | null): Promise<string> {
  if (Date.now() >= keyCacheExpiresAt || !keyCache.some(key => key.id === keyId)) {
    keyCache = await pawaPayClient.publicKeys(providerConfigurationKey);
    keyCacheExpiresAt = Date.now() + KEY_CACHE_TTL_MS;
  }
  const found = keyCache.find(key => key.id === keyId);
  if (!found) throw new PawaPayError('Unknown PawaPay signing key');
  return found.key;
}

export async function verifyPawaPayWebhook(request: Request, rawBody: string, providerConfigurationKey?: string | null): Promise<void> {
  const digest = requiredHeader(request, 'Content-Digest');
  requiredHeader(request, 'Content-Type');
  requiredHeader(request, 'Signature-Date');
  verifyDigest(rawBody, digest);
  const input = parseSignatureInput(requiredHeader(request, 'Signature-Input'));
  const now = Math.floor(Date.now() / 1000);
  if (input.algorithm !== 'ecdsa-p256-sha256' || input.created > now + CLOCK_SKEW_SECONDS || input.expires < now - CLOCK_SKEW_SECONDS || input.expires < input.created) throw new PawaPayError('Expired or unsupported PawaPay signature');
  const key = createPublicKey(await publicKey(input.keyId, providerConfigurationKey));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || !verify('sha256', Buffer.from(pawaPaySignatureBase(request, input)), key, signatureValue(requiredHeader(request, 'Signature'), input.label))) throw new PawaPayError('Invalid PawaPay signature');
}
