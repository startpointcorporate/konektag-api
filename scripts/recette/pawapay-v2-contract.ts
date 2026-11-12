// KON-75 — read-only pawaPay v2 SANDBOX contract check. Never against live, never a deposit.
//
// Calls only GET /v2/active-conf?country&operationType=DEPOSIT and POST /v2/predict-provider
// (toolkit, no money movement) through the real adapter, then prints the raw response shape
// next to what our parser extracts, so a mismatch with the real contract is visible.
//
// Env: PAWAPAY_CHECK_KEY (e.g. KTG_CG_PAWAPAY_SANDBOX, with <KEY>_API_URL / <KEY>_API_TOKEN set),
//      PAWAPAY_CHECK_COUNTRY (default COG), PAWAPAY_CHECK_CURRENCY (default XAF),
//      PAWAPAY_CHECK_PHONE (a pawaPay sandbox test MSISDN, default 242053456789).
// Run: npx tsx scripts/recette/pawapay-v2-contract.ts
import { resolvePawaPayConfiguration } from '../../src/infrastructure/adapters/provider-configuration.ts';
import { pawaPayClient } from '../../src/infrastructure/adapters/pawapay-client.ts';

const key = process.env.PAWAPAY_CHECK_KEY ?? '';
if (!/_PAWAPAY_SANDBOX$/.test(key)) { console.error('PAWAPAY_CHECK_KEY must be a *_PAWAPAY_SANDBOX configuration key'); process.exit(2); }
const { apiUrl } = resolvePawaPayConfiguration(key);
if (new URL(apiUrl).host !== 'api.sandbox.pawapay.io') { console.error(`Refusing non-sandbox host ${new URL(apiUrl).host}`); process.exit(2); }
const country = process.env.PAWAPAY_CHECK_COUNTRY ?? 'COG';
const currency = process.env.PAWAPAY_CHECK_CURRENCY ?? 'XAF';
const phone = process.env.PAWAPAY_CHECK_PHONE ?? '242053456789';

// Defence in depth: any other endpoint (deposits, payouts, refunds, Payment Page) is refused.
const realFetch = globalThis.fetch;
const raw: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['/v2/active-conf', '/v2/predict-provider'].includes(target.pathname)) throw new Error(`Refused ${target.pathname}`);
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

const providers = await pawaPayClient.depositProviders(country, currency, key);
console.log('active-conf raw shape:', JSON.stringify(shape(raw['/v2/active-conf']), null, 2));
console.log('active-conf parsed DEPOSIT providers:', JSON.stringify(providers, null, 2));
const prediction = await pawaPayClient.predictProvider(phone, key);
console.log('predict-provider raw shape:', JSON.stringify(shape(raw['/v2/predict-provider'])));
console.log('predict-provider parsed:', JSON.stringify(prediction));

const failures: string[] = [];
if (!providers.length) failures.push(`no DEPOSIT provider parsed for ${country}/${currency}`);
for (const p of providers) {
  if (p.status === 'UNKNOWN') failures.push(`${p.provider}: DEPOSIT.status not found`);
  if (p.decimalsInAmount === null) failures.push(`${p.provider}: decimalsInAmount not recognised`);
  if (p.authType === null) failures.push(`${p.provider}: authType not found`);
  if (p.minAmount === null || p.maxAmount === null) failures.push(`${p.provider}: DEPOSIT amount limits not found`);
}
if (prediction.country !== country) failures.push(`prediction country ${prediction.country} != ${country}`);
if (!providers.some(p => p.provider === prediction.provider)) failures.push(`predicted ${prediction.provider} absent from active-conf`);
console.log(failures.length ? `CONTRACT MISMATCH:\n- ${failures.join('\n- ')}` : 'CONTRACT OK (read-only, no deposit created)');
process.exit(failures.length ? 1 : 0);
