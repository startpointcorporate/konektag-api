// KON-75 — read-only pawaPay v2 SANDBOX contract check. Never against live, never a deposit.
//
// pawaPay enforces an IP allowlist: run this only from a pod of the K3s cluster that shares the
// API's egress (never from a workstation), otherwise a 403 proves nothing about the token.
// It first prints the effective public egress IP of the running pod, then calls only
// GET /v2/active-conf?country&operationType=DEPOSIT, GET /v2/public-key/http and
// POST /v2/predict-provider (toolkit, no money movement) through the real adapter, and prints the
// raw response shape next to what our parser extracts, so a mismatch with the real contract is visible.
//
// Env: PAWAPAY_CHECK_KEY (e.g. KTG_CG_PAWAPAY_SANDBOX, with <KEY>_API_URL / <KEY>_API_TOKEN set),
//      PAWAPAY_CHECK_COUNTRY (default COG), PAWAPAY_CHECK_CURRENCY (default XAF),
//      PAWAPAY_CHECK_PHONE (a pawaPay sandbox test MSISDN, default 242053456789),
//      PAWAPAY_CHECK_ALLOWED_IPS (optional, comma-separated allowlist configured at pawaPay),
//      PAWAPAY_CHECK_TOKEN_STDIN=1 (optional, read <KEY>_API_TOKEN from stdin instead of env).
// Run: npx tsx scripts/recette/pawapay-v2-contract.ts
import { resolvePawaPayConfiguration } from '../../src/infrastructure/adapters/provider-configuration.ts';
import { pawaPayClient } from '../../src/infrastructure/adapters/pawapay-client.ts';

const key = process.env.PAWAPAY_CHECK_KEY ?? '';
if (!/_PAWAPAY_SANDBOX$/.test(key)) { console.error('PAWAPAY_CHECK_KEY must be a *_PAWAPAY_SANDBOX configuration key'); process.exit(2); }
// PAWAPAY_CHECK_TOKEN_STDIN=1: the sandbox token is piped on stdin (`kubectl exec -i ... < token`),
// so it never appears in a command line, pod spec, env listing or log. The URL defaults to the sandbox.
if (process.env.PAWAPAY_CHECK_TOKEN_STDIN === '1') {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const token = Buffer.concat(chunks).toString('utf8').trim();
  if (!token || /\s/.test(token)) { console.error('PAWAPAY_CHECK_TOKEN_STDIN=1 but stdin holds no single-line token'); process.exit(2); }
  process.env[`${key}_API_TOKEN`] = token;
  process.env[`${key}_API_URL`] ??= 'https://api.sandbox.pawapay.io';
}
const { apiUrl } = resolvePawaPayConfiguration(key);
if (new URL(apiUrl).host !== 'api.sandbox.pawapay.io') { console.error(`Refusing non-sandbox host ${new URL(apiUrl).host}`); process.exit(2); }
const country = process.env.PAWAPAY_CHECK_COUNTRY ?? 'COG';
const currency = process.env.PAWAPAY_CHECK_CURRENCY ?? 'XAF';
const phone = process.env.PAWAPAY_CHECK_PHONE ?? '242053456789';
const allowedIps = (process.env.PAWAPAY_CHECK_ALLOWED_IPS ?? '').split(',').map(ip => ip.trim()).filter(Boolean);

const realFetch = globalThis.fetch;
const egressIp = (await realFetch('https://api.ipify.org').then(r => r.text()).catch(() => '')).trim();
console.log(`sandbox host: ${new URL(apiUrl).host}`);
console.log(`egress IP (this pod): ${egressIp || 'UNKNOWN'}; allowlist match: ${allowedIps.length ? allowedIps.includes(egressIp) : 'not provided'}`);

// Defence in depth: any other endpoint (deposits, payouts, refunds, Payment Page) is refused.
const raw: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['/v2/active-conf', '/v2/public-key/http', '/v2/predict-provider'].includes(target.pathname)) throw new Error(`Refused ${target.pathname}`);
  const response = await realFetch(input, init);
  raw[target.pathname] = await response.clone().json().catch(() => null);
  console.log(`${init?.method ?? 'GET'} ${target.pathname}${target.search} -> ${response.status}`);
  return response;
}) as typeof fetch;

/** Keys and types only: no values, so nothing account-specific is printed. */
function shape(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
  if (value && typeof value === 'object' && depth < 8) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  return typeof value;
}

/** On an HTTP error, print the pawaPay error codes (not messages) to tell token restrictions from IP filtering. */
async function step<T>(path: string, call: () => Promise<T>): Promise<T | null> {
  try { return await call(); } catch (error) {
    const body = raw[path] as Record<string, any> | null | undefined;
    const codes = [body?.failureReason?.failureCode, body?.errorCode, body?.code, body?.status].filter(v => typeof v === 'string');
    console.log(`${path} error: ${error instanceof Error ? error.message : String(error)}; codes: ${codes.join(',') || 'none'}; body shape: ${JSON.stringify(shape(body))}`);
    return null;
  }
}

const failures: string[] = [];
const providers = await step('/v2/active-conf', () => pawaPayClient.depositProviders(country, currency, key));
console.log('active-conf raw shape:', JSON.stringify(shape(raw['/v2/active-conf']), null, 2));
console.log('active-conf parsed DEPOSIT providers:', JSON.stringify(providers, null, 2));
const publicKeys = await step('/v2/public-key/http', () => pawaPayClient.publicKeys(key));
console.log('public-key/http raw shape:', JSON.stringify(shape(raw['/v2/public-key/http'])));
const prediction = await step('/v2/predict-provider', () => pawaPayClient.predictProvider(phone, key));
console.log('predict-provider raw shape:', JSON.stringify(shape(raw['/v2/predict-provider'])));
console.log('predict-provider parsed:', JSON.stringify(prediction));

if (!providers) failures.push('active-conf call failed');
else if (!providers.length) failures.push(`no DEPOSIT provider parsed for ${country}/${currency}`);
for (const p of providers ?? []) {
  if (p.status === 'UNKNOWN') failures.push(`${p.provider}: DEPOSIT.status not found`);
  if (p.decimalsInAmount === null) failures.push(`${p.provider}: decimalsInAmount not recognised`);
  if (p.authType === null) failures.push(`${p.provider}: authType not found`);
  if (p.minAmount === null || p.maxAmount === null) failures.push(`${p.provider}: DEPOSIT amount limits not found`);
}
if (!Array.isArray(publicKeys) || !publicKeys.length) failures.push('public-key/http returned no key');
if (!prediction) failures.push('predict-provider call failed');
else {
  if (prediction.country !== country) failures.push(`prediction country ${prediction.country} != ${country}`);
  if (providers && !providers.some(p => p.provider === prediction.provider)) failures.push(`predicted ${prediction.provider} absent from active-conf`);
}
console.log(failures.length ? `CONTRACT MISMATCH:\n- ${failures.join('\n- ')}` : 'CONTRACT OK (read-only, no deposit created)');
process.exit(failures.length ? 1 : 0);
