import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { resolvePawaPayConfiguration, type PawaPayProviderConfiguration } from './provider-configuration.ts';

export class PawaPayError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly failureCode: string | null = null) { super(message); }
}

export type PawaPayDepositStatus = 'ACCEPTED' | 'PROCESSING' | 'IN_RECONCILIATION' | 'COMPLETED' | 'FAILED';
export interface PawaPayDeposit {
  depositId: string;
  status: PawaPayDepositStatus;
  amount: string;
  currency: string;
  failureReason?: string;
}

/** Operator availability for one country, currency and DEPOSIT, read from /v2/active-conf. */
export interface PawaPayDepositProvider {
  provider: string;
  nameDisplayedToCustomer: string | null;
  currency: string;
  status: string;
  minAmount: string | null;
  maxAmount: string | null;
  decimalsInAmount: 'TWO_PLACES' | 'NONE' | null;
  authType: string | null;
  pinPrompt: string | null;
  pinPromptRevivable: boolean | null;
}
export interface PawaPayDirectDepositInput {
  depositId: string;
  phoneNumber: string;
  provider: string;
  /** Major-unit decimal string, as required by v2 (for example "7000" XAF or "12.21"). */
  amount: string;
  currency: string;
  customerMessage: string;
  clientReferenceId: string;
  metadata: Array<Record<string, string | boolean>>;
  providerConfigurationKey: string | null;
}
export type PawaPayDepositInitiation =
  | { status: 'ACCEPTED' | 'DUPLICATE_IGNORED' }
  | { status: 'REJECTED'; failureCode: string | null; failureMessage: string | null };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { failureReason?: { failureCode?: unknown } } | null;
    const code = typeof failure?.failureReason?.failureCode === 'string' ? failure.failureReason.failureCode : null;
    throw new PawaPayError(`PawaPay request failed (${response.status})`, response.status, code);
  }
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
  /** v2 toolkit: normalises the MSISDN and returns its country and operator. */
  async predictProvider(phoneNumber: string, providerConfigurationKey: string | null): Promise<{ country: string; provider: string; phoneNumber: string }> {
    const response = await api<{ country?: unknown; provider?: unknown; phoneNumber?: unknown }>('/v2/predict-provider', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber }),
    }, providerConfigurationKey);
    if (typeof response.country !== 'string' || !/^[A-Z]{3}$/.test(response.country)
      || typeof response.provider !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(response.provider)
      || typeof response.phoneNumber !== 'string' || !/^\d{6,20}$/.test(response.phoneNumber)) {
      throw new PawaPayError('PawaPay did not return a valid provider prediction');
    }
    return { country: response.country, provider: response.provider, phoneNumber: response.phoneNumber };
  },
  /** v2 direct deposit: the operator prompts the payer, who approves with their PIN on the phone. */
  async createDeposit(input: PawaPayDirectDepositInput): Promise<PawaPayDepositInitiation> {
    if (!UUID_V4.test(input.depositId)) throw new PawaPayError('depositId must be a UUIDv4');
    if (!/^([0]|([1-9][0-9]{0,17}))([.][0-9]{0,3}[1-9])?$/.test(input.amount) || !(Number(input.amount) > 0) || !/^[A-Z]{3}$/.test(input.currency)
      || !/^\d{6,20}$/.test(input.phoneNumber) || !/^[A-Z0-9_]{3,80}$/.test(input.provider)
      || !/^[A-Za-z0-9 ]{4,22}$/.test(input.customerMessage) || input.metadata.length > 10) {
      throw new PawaPayError('Invalid PawaPay deposit request');
    }
    const response = await api<{ depositId?: unknown; status?: unknown; failureReason?: { failureCode?: unknown; failureMessage?: unknown } }>('/v2/deposits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        depositId: input.depositId,
        payer: { type: 'MMO', accountDetails: { phoneNumber: input.phoneNumber, provider: input.provider } },
        amount: input.amount,
        currency: input.currency,
        clientReferenceId: input.clientReferenceId,
        customerMessage: input.customerMessage,
        metadata: input.metadata,
      }),
    }, input.providerConfigurationKey);
    if (response.status === 'ACCEPTED' || response.status === 'DUPLICATE_IGNORED') {
      if (response.depositId !== input.depositId) throw new PawaPayError('PawaPay deposit response does not match depositId');
      return { status: response.status };
    }
    if (response.status === 'REJECTED') {
      const code = response.failureReason?.failureCode; const message = response.failureReason?.failureMessage;
      return { status: 'REJECTED', failureCode: typeof code === 'string' ? code : null, failureMessage: typeof message === 'string' ? message : null };
    }
    throw new PawaPayError('Invalid PawaPay deposit initiation response');
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
  activeConfiguration(filter: { country?: string; operationType?: 'DEPOSIT' } = {}, providerConfigurationKey: string | null = null) {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value) as Array<[string, string]>).toString();
    return api<unknown>(`/v2/active-conf${query ? `?${query}` : ''}`, undefined, providerConfigurationKey);
  },
  /** DEPOSIT operators really enabled on the corridor account for one country and currency. */
  async depositProviders(country: string, currency: string, providerConfigurationKey: string | null): Promise<PawaPayDepositProvider[]> {
    const configuration = await this.activeConfiguration({ country, operationType: 'DEPOSIT' }, providerConfigurationKey) as any;
    const countries = Array.isArray(configuration?.countries) ? configuration.countries : [];
    const str = (value: unknown) => typeof value === 'string' ? value : null;
    return countries.filter((entry: any) => entry?.country === country).flatMap((entry: any) =>
      (Array.isArray(entry.providers) ? entry.providers : []).flatMap((provider: any) =>
        (Array.isArray(provider?.currencies) ? provider.currencies : [])
          .filter((row: any) => row?.currency === currency && row?.operationTypes?.DEPOSIT && typeof provider.provider === 'string')
          .map((row: any): PawaPayDepositProvider => {
            const deposit = row.operationTypes.DEPOSIT;
            // The v2 schema names the limits minAmount/maxAmount while its example uses
            // minTransactionLimit/maxTransactionLimit: accept both rather than silently drop the limits.
            return {
              provider: provider.provider, nameDisplayedToCustomer: str(provider.nameDisplayedToCustomer), currency,
              status: str(deposit.status) ?? 'UNKNOWN',
              minAmount: str(deposit.minAmount) ?? str(deposit.minTransactionLimit),
              maxAmount: str(deposit.maxAmount) ?? str(deposit.maxTransactionLimit),
              decimalsInAmount: deposit.decimalsInAmount === 'TWO_PLACES' || deposit.decimalsInAmount === 'NONE' ? deposit.decimalsInAmount : null,
              authType: str(deposit.authType), pinPrompt: str(deposit.pinPrompt),
              pinPromptRevivable: typeof deposit.pinPromptRevivable === 'boolean' ? deposit.pinPromptRevivable : null,
            };
          })));
  },
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
