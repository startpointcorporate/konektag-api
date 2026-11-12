import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PawaPayError, pawaPaySignatureBase, verifyPawaPayWebhook } from '../../src/infrastructure/adapters/pawapay-client.ts';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedRequest(options: { body?: string; path?: string; authority?: string; keyId?: string; created?: number; expires?: number; digest?: string; signatureInput?: string; signature?: string; signatureDate?: string } = {}) {
  const body = options.body ?? '{"depositId":"00000000-0000-4000-8000-000000000001"}'; const now = Math.floor(Date.now() / 1000); const created = options.created ?? now; const expires = options.expires ?? now + 60;
  const input = options.signatureInput ?? `sig-pp=("@method" "@authority" "@path" "signature-date" "content-digest" "content-type");alg="ecdsa-p256-sha256";keyid="${options.keyId ?? 'HTTP_EC_P256_KEY:1'}";created=${created};expires=${expires}`;
  const digest = options.digest ?? `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
  const request = new Request(`https://${options.authority ?? 'www.konektag.eu'}${options.path ?? '/api/webhooks/pawapay/deposits'}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Signature-Date': options.signatureDate ?? new Date(created * 1000).toUTCString(), 'Content-Digest': digest, 'Signature-Input': input }, body });
  const base = pawaPaySignatureBase(request, (awaitableParse(input)));
  request.headers.set('Signature', options.signature ?? `sig-pp=:${sign('sha256', Buffer.from(base), pair.privateKey).toString('base64')}:`);
  return request;
}

function awaitableParse(value: string) { const match = /^([^=]+)=\(([^)]*)\)(.*)$/.exec(value)!; const params = match[3]; const get = (name: string) => new RegExp(`;${name}=(?:"([^"]+)"|([^;]+))`).exec(params)!; return { label: match[1], components: [...match[2].matchAll(/"([^"]+)"/g)].map(([, value]) => value), params, keyId: get('keyid')[1] ?? get('keyid')[2], algorithm: get('alg')[1] ?? get('alg')[2], created: Number(get('created')[1] ?? get('created')[2]), expires: Number(get('expires')[1] ?? get('expires')[2]) }; }

describe('PawaPay RFC 9421 signatures', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { process.env.PAWAPAY_API_URL = 'https://api.sandbox.pawapay.io'; process.env.PAWAPAY_API_TOKEN = 'test-token'; vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 'HTTP_EC_P256_KEY:1', key: publicPem }]), { status: 200 }))); });
  afterEach(() => { vi.unstubAllGlobals(); globalThis.fetch = originalFetch; delete process.env.PAWAPAY_API_URL; delete process.env.PAWAPAY_API_TOKEN; });
  it('accepts a real ECDSA P-256 signature', async () => { await expect(verifyPawaPayWebhook(signedRequest(), '{"depositId":"00000000-0000-4000-8000-000000000001"}')).resolves.toBeUndefined(); });
  it.each(['not-a-date', new Date(0).toISOString()])('rejects a signed but invalid or inconsistent Signature-Date: %s', async signatureDate => {
    await expect(verifyPawaPayWebhook(signedRequest({ signatureDate }), '{"depositId":"00000000-0000-4000-8000-000000000001"}')).rejects.toBeInstanceOf(PawaPayError);
  });
  it('rejects a correctly signed message without all required signed components', async () => {
    const now = Math.floor(Date.now() / 1000);
    const signatureInput = `sig-pp=("signature-date");alg="ecdsa-p256-sha256";keyid="HTTP_EC_P256_KEY:1";created=${now};expires=${now + 60}`;
    await expect(verifyPawaPayWebhook(signedRequest({ signatureInput }), '{"depositId":"00000000-0000-4000-8000-000000000001"}')).rejects.toBeInstanceOf(PawaPayError);
  });
  it('rejects an old signature with an arbitrarily distant expiration', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verifyPawaPayWebhook(signedRequest({ created: now - 86400, expires: now + 86400 }), '{"depositId":"00000000-0000-4000-8000-000000000001"}')).rejects.toBeInstanceOf(PawaPayError);
  });
  it('does not reuse a public key from another provider configuration', async () => {
    const body = '{"depositId":"00000000-0000-4000-8000-000000000001"}';
    await verifyPawaPayWebhook(signedRequest(), body);
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_URL = 'https://api.sandbox.pawapay.io';
    process.env.KTG_CG_PAWAPAY_SANDBOX_API_TOKEN = 'scoped-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]')));
    try { await expect(verifyPawaPayWebhook(signedRequest(), body, 'KTG_CG_PAWAPAY_SANDBOX')).rejects.toBeInstanceOf(PawaPayError); }
    finally { delete process.env.KTG_CG_PAWAPAY_SANDBOX_API_URL; delete process.env.KTG_CG_PAWAPAY_SANDBOX_API_TOKEN; }
  });
  it.each([
    ['modified body', () => [signedRequest(), '{"tampered":true}'] as const],
    ['modified digest', () => [signedRequest({ digest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:' }), '{"depositId":"00000000-0000-4000-8000-000000000001"}'] as const],
    ['modified signature', () => [signedRequest({ signature: 'sig-pp=:AAAA:' }), '{"depositId":"00000000-0000-4000-8000-000000000001"}'] as const],
    ['unknown key', () => [signedRequest({ keyId: 'missing' }), '{"depositId":"00000000-0000-4000-8000-000000000001"}'] as const],
    ['expired signature', () => [signedRequest({ created: 1, expires: 2 }), '{"depositId":"00000000-0000-4000-8000-000000000001"}'] as const],
    ['future signature', () => [signedRequest({ created: Math.floor(Date.now() / 1000) + 120, expires: Math.floor(Date.now() / 1000) + 180 }), '{"depositId":"00000000-0000-4000-8000-000000000001"}'] as const],
  ])('rejects %s', async (_name, make) => { const [request, body] = make(); await expect(verifyPawaPayWebhook(request, body)).rejects.toBeInstanceOf(PawaPayError); });
  it('rejects a Signature-Input modified after signing', async () => { const request = signedRequest(); request.headers.set('Signature-Input', request.headers.get('Signature-Input')!.replace('"content-type"', '"content-digest"')); await expect(verifyPawaPayWebhook(request, '{"depositId":"00000000-0000-4000-8000-000000000001"}')).rejects.toBeInstanceOf(PawaPayError); });
  it.each([['path', () => signedRequest({ path: '/api/webhooks/pawapay/other' })], ['authority', () => signedRequest({ authority: 'evil.example' })]])('rejects a signature made for another %s', async (_name, make) => { const request = make(); const expected = signedRequest(); await expect(verifyPawaPayWebhook(new Request(expected.url, { method: 'POST', headers: request.headers, body: '{"depositId":"00000000-0000-4000-8000-000000000001"}' }), '{"depositId":"00000000-0000-4000-8000-000000000001"}')).rejects.toBeInstanceOf(PawaPayError); });
});
