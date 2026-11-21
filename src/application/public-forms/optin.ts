/**
 * Marketing opt-in of an authorised site, written to the standard Frappe
 * Email Group / Email Group Member of the tenant.
 *
 * 1. request:     explicit consent (accepted = true, text and version shown), then a
 *                 confirmation e-mail; nothing is written to Frappe yet.
 * 2. confirm:     the single-use link proves the address; the member is created
 *                 inactive, the proof is attached as a Comment, then the member is
 *                 activated. A member is never active without its proof.
 * 3. unsubscribe: signed, permanent token; the member is deactivated first, then
 *                 the withdrawal is recorded.
 *
 * Double opt-in is always used: an anonymous form never proves that the visitor
 * owns the address. The `newsletter` app is not installed on the sites
 * (2026-11-21), so its guest subscribe/confirm methods are not available.
 * The visitor chooses a public list key; the Email Group comes from the
 * server configuration of the tenant, never from the browser.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { FrappeSiteError, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import type { PublicFormSite, PublicFormSites } from './site.ts';
import {
  enforceRateLimits, escapeHtml, FormError, formSecret, logFormEvent, normalizeEmail, pseudonym, sha256,
  verifyTurnstile, withLease, type FormStore,
} from './guards.ts';

const LIST_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PENDING_TTL_SEC = 72 * 3600;
const CONFIRMED_TTL_SEC = 30 * 24 * 3600;
const PROOF_VERSION = 'konektag-consent-proof/1';

export const optinSchema = z.object({
  siteId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/).optional(),
  country: z.string().trim().min(2).max(100).optional(),
  list: z.string().trim().regex(LIST_KEY),
  email: z.string().trim().email().max(254),
  locale: z.enum(['fr', 'en']).optional().default('fr'),
  consent: z.object({
    accepted: z.literal(true),
    textVersion: z.string().trim().min(1).max(64),
    text: z.string().trim().min(10).max(2000),
  }).strict(),
  confirmationUrl: z.string().trim().url().max(500),
  sourceUrl: z.string().trim().url().max(500).optional(),
  campaign: z.string().trim().min(1).max(140).optional(),
  website: z.string().max(200).optional().default(''),
  turnstileToken: z.string().max(2048).optional().default(''),
}).strict();

export const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const unsubscribeSchema = z.object({ token: z.string().min(20).max(1024).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/) }).strict();

export type OptinInput = z.infer<typeof optinSchema>;

type TenantOptin = { confirmationOrigins: string[]; lists: Record<string, string> };

type Pending = {
  state: 'pending' | 'confirmed';
  tenantId: string;
  siteId: string;
  list: string;
  emailGroup: string;
  email: string;
  locale: 'fr' | 'en';
  consent: { textVersion: string; textSha256: string; text: string };
  requestedAt: string;
  origin: string | null;
  sourceUrl: string | null;
  campaign: string | null;
  requestPeer: string;
  member?: string;
  unsubscribeToken?: string;
};

export type OptinDeps = {
  sites: PublicFormSites;
  store: FormStore;
  sendEmail: (mail: { to: string; subject: string; html: string; idempotencyKey?: string }) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * PUBLIC_OPTIN_LISTS = {"<tenantId>": {"confirmationOrigins": ["https://…"], "lists": {"<key>": "<Email Group>"}}}
 * Read on each call; an invalid document disables every opt-in rather than guessing.
 */
export function tenantOptin(tenantId: string, env: NodeJS.ProcessEnv = process.env): TenantOptin | null {
  let config: unknown;
  try { config = JSON.parse(env.PUBLIC_OPTIN_LISTS || '{}'); } catch { throw new FormError('SERVICE_UNAVAILABLE', 503); }
  if (!config || typeof config !== 'object' || !Object.hasOwn(config, tenantId)) return null;
  const entry = (config as Record<string, any>)[tenantId];
  const origins = Array.isArray(entry?.confirmationOrigins) ? entry.confirmationOrigins.filter((o: unknown) => typeof o === 'string') : [];
  const lists = entry?.lists && typeof entry.lists === 'object' ? entry.lists : {};
  const valid: Record<string, string> = {};
  for (const [key, group] of Object.entries(lists)) if (LIST_KEY.test(key) && typeof group === 'string' && group.trim()) valid[key] = group;
  return { confirmationOrigins: origins.map((o: string) => { try { return new URL(o).origin; } catch { return ''; } }).filter(Boolean), lists: valid };
}

function allowedConfirmationUrl(value: string, origins: string[]): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) return null;
  return origins.includes(url.origin) ? url : null;
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** Permanent unsubscribe capability: identifies the member, never the address. */
export function signUnsubscribe(claims: { tenantId: string; siteId: string; member: string; emailGroup: string }, secret: string): string {
  const payload = b64(JSON.stringify({ v: 1, t: claims.tenantId, s: claims.siteId, m: claims.member, g: claims.emailGroup }));
  return payload + '.' + b64(createHmac('sha256', secret).update('unsubscribe.' + payload).digest());
}

export function verifyUnsubscribe(token: string, secret: string): { tenantId: string; siteId: string; member: string; emailGroup: string } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update('unsubscribe.' + payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims?.v !== 1 || ![claims.t, claims.s, claims.m, claims.g].every(v => typeof v === 'string' && v)) return null;
    return { tenantId: claims.t, siteId: claims.s, member: claims.m, emailGroup: claims.g };
  } catch {
    return null;
  }
}

function frappeFailure(error: unknown, site: PublicFormSite, step: string): FormError {
  if (error instanceof FormError) return error;
  const detail = error instanceof FrappeSiteError
    ? { code: error.code, httpStatus: error.httpStatus, excType: error.excType }
    : { code: error instanceof Error ? error.name : 'Error' };
  console.error('[public-forms] opt-in Frappe call failed', JSON.stringify({ step, tenantId: site.tenantId, siteId: site.siteId, ...detail }));
  return new FormError('OPTIN_UNAVAILABLE', 503);
}

function confirmationMail(p: Pending, link: string, host: string) {
  const fr = p.locale === 'fr';
  const subject = fr ? 'Confirmez votre inscription' : 'Please confirm your subscription';
  const intro = fr
    ? `Vous avez demandé à recevoir les communications de ${host}. Confirmez votre adresse pour finaliser l'inscription.`
    : `You asked to receive communications from ${host}. Confirm your address to complete the subscription.`;
  const button = fr ? 'Confirmer mon inscription' : 'Confirm my subscription';
  const ignore = fr
    ? "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : aucune inscription ne sera faite. Ce lien expire dans 72 heures."
    : 'If you did not make this request, ignore this message: you will not be subscribed. This link expires in 72 hours.';
  const consent = fr ? 'Consentement donné' : 'Consent given';
  return {
    subject,
    html: '<!doctype html><html lang="' + p.locale + '"><body style="font-family:Arial,sans-serif;padding:24px">'
      + '<main style="max-width:580px;margin:auto"><p>' + escapeHtml(intro) + '</p>'
      + '<p><a href="' + escapeHtml(link) + '" style="display:inline-block;padding:12px 20px;background:#2b1b67;color:#fff;border-radius:8px;text-decoration:none">' + escapeHtml(button) + '</a></p>'
      + '<p style="font-size:12px;color:#536077">' + escapeHtml(consent) + ' (' + escapeHtml(p.consent.textVersion) + ') : « ' + escapeHtml(p.consent.text) + ' »</p>'
      + '<p style="font-size:12px;color:#536077">' + escapeHtml(ignore) + '</p></main></body></html>',
  };
}

const pendingKey = (token: string) => 'public-forms:optin:pending:' + sha256(token);

async function findMember(frappe: FrappeSite, emailGroup: string, email: string) {
  const rows = await frappe.list('Email Group Member', [['email_group', '=', emailGroup], ['email', '=', email]], ['name', 'unsubscribed'], 2) as Array<{ name: string; unsubscribed: number | boolean }>;
  return rows[0] ?? null;
}

function proofComment(member: string, proof: Record<string, unknown>) {
  return {
    comment_type: 'Info',
    reference_doctype: 'Email Group Member',
    reference_name: member,
    content: '<p><b>' + PROOF_VERSION + '</b></p><pre>' + escapeHtml(JSON.stringify(proof, null, 2)) + '</pre>',
  };
}

export async function requestOptin(
  raw: unknown,
  request: { origin: string | null; clientAddress: string },
  deps: OptinDeps,
): Promise<void> {
  const parsed = optinSchema.safeParse(raw);
  if (!parsed.success) throw new FormError('BAD_FIELDS', 400);
  const input = parsed.data;
  if (input.website) throw new FormError('SPAM_REJECTED', 400);
  const env = deps.env ?? process.env;
  const secret = formSecret(env);
  const site = await deps.sites.resolve({ siteId: input.siteId, country: input.country }, { operation: 'optin', origin: request.origin });
  const config = tenantOptin(site.tenantId, env);
  const emailGroup = config && Object.hasOwn(config.lists, input.list) ? config.lists[input.list] : null;
  if (!config || !emailGroup) throw new FormError('OPTIN_LIST_NOT_FOUND', 404);
  const confirmation = allowedConfirmationUrl(input.confirmationUrl, config.confirmationOrigins);
  if (!confirmation) throw new FormError('CONFIRMATION_URL_NOT_ALLOWED', 403);

  const email = normalizeEmail(input.email);
  const emailId = pseudonym(email, secret);
  const requestPeer = pseudonym(request.clientAddress || 'unknown-peer', secret);
  await enforceRateLimits(deps.store, 'optin:' + site.tenantId, [
    { key: 'email:' + emailId, max: 3, windowSec: 3600 },
    { key: 'peer:' + requestPeer, max: 20, windowSec: 3600 },
    { key: 'site', max: 500, windowSec: 3600 },
  ]);
  await verifyTurnstile(input.turnstileToken, 'public-optin', request.origin, env, deps.fetchImpl);

  let member: Awaited<ReturnType<typeof findMember>>;
  try {
    // The Email Group must exist before a visitor is asked to confirm anything.
    await site.frappe.get('Email Group', emailGroup);
    member = await findMember(site.frappe, emailGroup, email);
  } catch (error) {
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' && error.httpStatus === 404) {
      console.error('[public-forms] configured Email Group is absent', JSON.stringify({ tenantId: site.tenantId, siteId: site.siteId, list: input.list }));
      throw new FormError('OPTIN_LIST_UNAVAILABLE', 503);
    }
    throw frappeFailure(error, site, 'lookup');
  }
  // Same answer whether or not the address is already subscribed: no enumeration.
  if (member && !Number(member.unsubscribed)) {
    logFormEvent('optin.already_subscribed', { tenantId: site.tenantId, siteId: site.siteId, list: input.list, emailId });
    return;
  }

  const token = b64(randomBytes(32));
  const pending: Pending = {
    state: 'pending', tenantId: site.tenantId, siteId: site.siteId, list: input.list, emailGroup, email, locale: input.locale,
    consent: { textVersion: input.consent.textVersion, textSha256: sha256(input.consent.text), text: input.consent.text },
    requestedAt: (deps.now?.() ?? new Date()).toISOString(),
    origin: request.origin, sourceUrl: input.sourceUrl ?? null, campaign: input.campaign ?? null, requestPeer,
  };
  try { await deps.store.setValue(pendingKey(token), JSON.stringify(pending), PENDING_TTL_SEC); }
  catch { throw new FormError('SERVICE_UNAVAILABLE', 503); }
  confirmation.searchParams.set('token', token);
  const mail = confirmationMail(pending, confirmation.toString(), confirmation.hostname);
  const sent = await deps.sendEmail({ to: email, ...mail, idempotencyKey: 'public-optin/' + sha256(token) });
  if (!sent) {
    await deps.store.setValue(pendingKey(token), '', 1).catch(() => undefined);
    throw new FormError('CONFIRMATION_EMAIL_UNAVAILABLE', 503);
  }
  logFormEvent('optin.confirmation_sent', { tenantId: site.tenantId, siteId: site.siteId, list: input.list, emailId, resubscription: member !== null });
}

export async function confirmOptin(
  raw: unknown,
  request: { clientAddress: string },
  deps: OptinDeps,
): Promise<{ list: string; unsubscribeToken: string }> {
  const parsed = tokenSchema.safeParse(raw);
  if (!parsed.success) throw new FormError('BAD_FIELDS', 400);
  const env = deps.env ?? process.env;
  const secret = formSecret(env);
  const confirmPeer = pseudonym(request.clientAddress || 'unknown-peer', secret);
  await enforceRateLimits(deps.store, 'optin-confirm', [{ key: 'peer:' + confirmPeer, max: 60, windowSec: 3600 }]);
  const key = pendingKey(parsed.data.token);
  const load = async (): Promise<Pending | null> => {
    let stored: string | null;
    try { stored = await deps.store.getValue(key); } catch { throw new FormError('SERVICE_UNAVAILABLE', 503); }
    return stored ? JSON.parse(stored) as Pending : null;
  };
  const first = await load();
  if (!first) throw new FormError('CONFIRMATION_NOT_FOUND', 404);
  if (first.state === 'confirmed') return { list: first.list, unsubscribeToken: first.unsubscribeToken! };

  return withLease(deps.store, 'public-forms:optin:lease:' + sha256(parsed.data.token), async () => {
    const p = await load();
    if (!p) throw new FormError('CONFIRMATION_NOT_FOUND', 404);
    if (p.state === 'confirmed') return { list: p.list, unsubscribeToken: p.unsubscribeToken! };
    const site = await deps.sites.resolveRecorded(p.tenantId, p.siteId);
    const confirmedAt = (deps.now?.() ?? new Date()).toISOString();
    let member: string;
    try {
      const existing = await findMember(site.frappe, p.emailGroup, p.email);
      if (existing) member = existing.name;
      else {
        try {
          const created = await site.frappe.insert('Email Group Member', { email_group: p.emailGroup, email: p.email, unsubscribed: 1 }) as { name?: string };
          if (!created?.name) throw new FrappeSiteError('SITE_REJECTED');
          member = created.name;
        } catch (error) {
          // A concurrent confirmation of the same address may have created it first.
          const again = await findMember(site.frappe, p.emailGroup, p.email);
          if (!again) throw error;
          member = again.name;
        }
      }
      await site.frappe.insert('Comment', proofComment(member, {
        action: 'opt-in', method: 'double-opt-in', list: p.list, emailGroup: p.emailGroup,
        consentTextVersion: p.consent.textVersion, consentTextSha256: p.consent.textSha256, consentText: p.consent.text,
        requestedAt: p.requestedAt, confirmedAt, tenantId: p.tenantId, siteId: p.siteId,
        origin: p.origin, sourceUrl: p.sourceUrl, campaign: p.campaign, locale: p.locale,
        requestPeer: p.requestPeer, confirmPeer,
      }));
      await site.frappe.update('Email Group Member', member, { unsubscribed: 0 });
    } catch (error) {
      throw frappeFailure(error, site, 'confirm');
    }
    const unsubscribeToken = signUnsubscribe({ tenantId: p.tenantId, siteId: p.siteId, member, emailGroup: p.emailGroup }, secret);
    try { await deps.store.setValue(key, JSON.stringify({ ...p, state: 'confirmed', member, unsubscribeToken }), CONFIRMED_TTL_SEC); }
    catch { /* already subscribed in Frappe; a second click is answered from Frappe again */ }
    logFormEvent('optin.confirmed', { tenantId: p.tenantId, siteId: p.siteId, list: p.list, emailId: pseudonym(p.email, secret), member });
    return { list: p.list, unsubscribeToken };
  });
}

export async function unsubscribe(
  raw: unknown,
  request: { clientAddress: string },
  deps: Omit<OptinDeps, 'sendEmail'>,
): Promise<void> {
  const parsed = unsubscribeSchema.safeParse(raw);
  if (!parsed.success) throw new FormError('UNSUBSCRIBE_TOKEN_INVALID', 400);
  const env = deps.env ?? process.env;
  const secret = formSecret(env);
  const claims = verifyUnsubscribe(parsed.data.token, secret);
  if (!claims) throw new FormError('UNSUBSCRIBE_TOKEN_INVALID', 400);
  const peer = pseudonym(request.clientAddress || 'unknown-peer', secret);
  await enforceRateLimits(deps.store, 'optin-unsubscribe', [{ key: 'peer:' + peer, max: 60, windowSec: 3600 }]);
  const site = await deps.sites.resolveRecorded(claims.tenantId, claims.siteId);
  let current: { email_group?: string; unsubscribed?: number | boolean };
  try {
    current = await site.frappe.get('Email Group Member', claims.member);
  } catch (error) {
    // Deleted member: there is nothing left to send to.
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' && error.httpStatus === 404) return;
    throw frappeFailure(error, site, 'unsubscribe');
  }
  if (current?.email_group !== claims.emailGroup) throw new FormError('UNSUBSCRIBE_TOKEN_INVALID', 400);
  if (Number(current.unsubscribed)) return;
  try { await site.frappe.update('Email Group Member', claims.member, { unsubscribed: 1 }); }
  catch (error) { throw frappeFailure(error, site, 'unsubscribe'); }
  // Withdrawal is effective even if its trace cannot be written.
  await site.frappe.insert('Comment', proofComment(claims.member, {
    action: 'unsubscribe', emailGroup: claims.emailGroup, unsubscribedAt: (deps.now?.() ?? new Date()).toISOString(),
    tenantId: claims.tenantId, siteId: claims.siteId, peer,
  })).catch(error => { frappeFailure(error, site, 'unsubscribe-proof'); });
  logFormEvent('optin.unsubscribed', { tenantId: claims.tenantId, siteId: claims.siteId, member: claims.member });
}
