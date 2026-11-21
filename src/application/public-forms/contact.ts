/**
 * Generic contact form of an authorised site, written to the tenant's Frappe CRM.
 *
 *   intent sales | general -> Lead (found by email, else created) + received Communication on it
 *   intent support         -> Issue (raised_by = email; ERPNext links the Lead/Contact itself)
 *
 * A contact never subscribes anyone: no Email Group Member is written and no
 * e-mail is sent. The answer carries an opaque reference, also written in the
 * Frappe subject, so the team can find the request without exposing CRM names.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { FrappeSiteError, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import type { PublicFormSite, PublicFormSites } from './site.ts';
import {
  enforceRateLimits, escapeHtml, FormError, formSecret, logFormEvent, normalizeEmail, pseudonym, sha256,
  verifyTurnstile, withLease, type FormStore,
} from './guards.ts';

const selector = {
  siteId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/).optional(),
  country: z.string().trim().min(2).max(100).optional(),
};

const utmValue = z.string().trim().min(1).max(140);

export const contactSchema = z.object({
  ...selector,
  intent: z.enum(['sales', 'support', 'general']),
  locale: z.enum(['fr', 'en']).optional().default('fr'),
  // Lengths and phone characters of the Frappe Data / Phone fields, so a visitor typo is a 400, not a CRM rejection.
  name: z.string().trim().min(2).max(140),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(/^[0-9 +_\-,.*#()]{0,20}$/).optional().default(''),
  company: z.string().trim().max(140).optional().default(''),
  subject: z.string().trim().max(200).optional().default(''),
  message: z.string().trim().min(3).max(5000),
  sourceUrl: z.string().trim().url().max(500).optional(),
  campaign: z.object({ source: utmValue.optional(), medium: utmValue.optional(), name: utmValue.optional() }).strict().optional(),
  website: z.string().max(200).optional().default(''),
  turnstileToken: z.string().max(2048).optional().default(''),
}).strict();

export type ContactInput = z.infer<typeof contactSchema>;

export type ContactResult = { reference: string; replayed: boolean };

export type ContactDeps = {
  sites: PublicFormSites;
  store: FormStore;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const DONE_TTL_SEC = 24 * 3600;

/** Opaque, non-sequential request reference, e.g. WEB-7K2Q9XHT4M. */
export function contactReference(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  return 'WEB-' + [...randomBytes(10)].map(b => alphabet[b % alphabet.length]).join('');
}

function crmError(error: unknown, site: PublicFormSite, step: string): FormError {
  if (error instanceof FormError) return error;
  if (error instanceof FrappeSiteError) {
    console.error('[public-forms] contact CRM write failed', JSON.stringify({
      step, tenantId: site.tenantId, siteId: site.siteId, code: error.code, httpStatus: error.httpStatus, excType: error.excType,
    }));
    return new FormError(error.code === 'SITE_REJECTED' ? 'CRM_REJECTED' : 'CRM_UNAVAILABLE', 503);
  }
  console.error('[public-forms] contact CRM write failed', JSON.stringify({ step, tenantId: site.tenantId, error: error instanceof Error ? error.name : 'Error' }));
  return new FormError('CRM_UNAVAILABLE', 503);
}

/** Keeps a UTM value only when the site already has it: a Link to an absent record would reject the Lead. */
async function existingLink(frappe: FrappeSite, doctype: string, value: string | undefined): Promise<string | null> {
  if (!value) return null;
  try {
    const rows = await frappe.list(doctype, [['name', '=', value]], ['name'], 1) as Array<{ name: string }>;
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

function body(input: ContactInput, reference: string, site: PublicFormSite, origin: string | null, receivedAt: string): string {
  const lines: Array<[string, string]> = [
    ['Référence', reference],
    ['Intention', input.intent],
    ['Nom', input.name],
    ['E-mail', input.email],
    ...(input.phone ? [['Téléphone', input.phone] as [string, string]] : []),
    ...(input.company ? [['Société', input.company] as [string, string]] : []),
    ['Site', site.tenantId],
    ...(origin ? [['Origine', origin] as [string, string]] : []),
    ...(input.sourceUrl ? [['Page', input.sourceUrl] as [string, string]] : []),
    ...(input.campaign ? [['Campagne', [input.campaign.source, input.campaign.medium, input.campaign.name].filter(Boolean).join(' / ')] as [string, string]] : []),
    ['Reçu (UTC)', receivedAt],
  ];
  return '<p>' + escapeHtml(input.message).replace(/\n/g, '<br>') + '</p><hr><p>'
    + lines.map(([k, v]) => '<b>' + escapeHtml(k) + '</b> : ' + escapeHtml(v)).join('<br>') + '</p>';
}

function title(input: ContactInput, reference: string): string {
  const fallback = input.intent === 'support'
    ? (input.locale === 'fr' ? 'Demande de support' : 'Support request')
    : (input.locale === 'fr' ? 'Demande de contact' : 'Contact request');
  return ('[' + reference + '] ' + (input.subject || fallback)).slice(0, 140);
}

const oldestLead = async (frappe: FrappeSite, email: string): Promise<string | null> =>
  ((await frappe.list('Lead', [['email_id', '=', email]], ['name'], 1, 'creation asc')) as Array<{ name: string }>)[0]?.name ?? null;

/** Oldest Lead of this email, else a new Lead. */
async function leadFor(site: PublicFormSite, input: ContactInput, email: string): Promise<{ name: string; created: boolean }> {
  const frappe = site.frappe;
  const existing = await oldestLead(frappe, email);
  if (existing) return { name: existing, created: false };
  const [utmSource, utmMedium, utmCampaign] = await Promise.all([
    existingLink(frappe, 'UTM Source', input.campaign?.source),
    existingLink(frappe, 'UTM Medium', input.campaign?.medium),
    existingLink(frappe, 'UTM Campaign', input.campaign?.name),
  ]);
  let created: { name?: string };
  try {
    created = await frappe.insert('Lead', {
      ...site.leadDefaults,
      lead_name: input.name,
      email_id: email,
      ...(input.company ? { company_name: input.company } : {}),
      ...(input.phone ? { mobile_no: input.phone } : {}),
      ...(utmSource ? { utm_source: utmSource } : {}),
      ...(utmMedium ? { utm_medium: utmMedium } : {}),
      ...(utmCampaign ? { utm_campaign: utmCampaign } : {}),
    }) as { name?: string };
  } catch (error) {
    // A concurrent request of the same address may have created it (ERPNext refuses a duplicate email).
    const raced = error instanceof FrappeSiteError && error.code === 'SITE_REJECTED' ? await oldestLead(frappe, email) : null;
    if (!raced) throw error;
    return { name: raced, created: false };
  }
  if (!created?.name) throw new FrappeSiteError('SITE_REJECTED');
  return { name: created.name, created: true };
}

async function record(site: PublicFormSite, input: ContactInput, email: string, reference: string, origin: string | null, receivedAt: string) {
  const content = body(input, reference, site, origin, receivedAt);
  if (input.intent === 'support') {
    let issue: { name?: string };
    try {
      issue = await site.frappe.insert('Issue', { subject: title(input, reference), raised_by: email, description: content }) as { name?: string };
    } catch (error) { throw crmError(error, site, 'issue'); }
    if (!issue?.name) throw crmError(new FrappeSiteError('SITE_REJECTED'), site, 'issue');
    return { doctype: 'Issue', created: true };
  }
  let lead: { name: string; created: boolean };
  try { lead = await leadFor(site, input, email); } catch (error) { throw crmError(error, site, 'lead'); }
  try {
    await site.frappe.insert('Communication', {
      communication_type: 'Communication',
      communication_medium: 'Email',
      sent_or_received: 'Received',
      subject: title(input, reference),
      content,
      sender: email,
      sender_full_name: input.name,
      ...(input.phone ? { phone_no: input.phone } : {}),
      reference_doctype: 'Lead',
      reference_name: lead.name,
    });
  } catch (error) { throw crmError(error, site, 'communication'); }
  return { doctype: 'Lead', created: lead.created };
}

export async function submitContact(
  raw: unknown,
  request: { origin: string | null; clientAddress: string; idempotencyKey: string | null },
  deps: ContactDeps,
): Promise<ContactResult> {
  const parsed = contactSchema.safeParse(raw);
  if (!parsed.success) throw new FormError('BAD_FIELDS', 400);
  const input = parsed.data;
  if (input.website) throw new FormError('SPAM_REJECTED', 400);
  if (request.idempotencyKey !== null && !IDEMPOTENCY_KEY.test(request.idempotencyKey)) throw new FormError('BAD_IDEMPOTENCY_KEY', 400);
  const env = deps.env ?? process.env;
  const secret = formSecret(env);
  const site = await deps.sites.resolve({ siteId: input.siteId, country: input.country }, { operation: 'contact', origin: request.origin });
  const email = normalizeEmail(input.email);
  const emailId = pseudonym(email, secret);
  await enforceRateLimits(deps.store, 'contact:' + site.tenantId, [
    { key: 'email:' + emailId, max: 5, windowSec: 3600 },
    // clientAddress may be a shared proxy: the peer limit only stops floods, as for commercial-request.
    { key: 'peer:' + pseudonym(request.clientAddress || 'unknown-peer', secret), max: 120, windowSec: 3600 },
    { key: 'site', max: 500, windowSec: 3600 },
  ]);
  await verifyTurnstile(input.turnstileToken, 'public-contact', request.origin, env, deps.fetchImpl);

  const fingerprint = sha256([site.tenantId, input.intent, email, input.subject, input.message].join('\u0000'));
  const scope = sha256(site.tenantId + '\u0000' + (request.idempotencyKey ?? fingerprint));
  const doneKey = 'public-forms:contact:done:' + scope;
  const previous = async (): Promise<ContactResult | null> => {
    let stored: string | null;
    try { stored = await deps.store.getValue(doneKey); } catch { throw new FormError('SERVICE_UNAVAILABLE', 503); }
    if (!stored) return null;
    const done = JSON.parse(stored) as { reference: string; fingerprint: string };
    if (done.fingerprint !== fingerprint) throw new FormError('IDEMPOTENCY_KEY_REUSED', 409);
    return { reference: done.reference, replayed: true };
  };
  const replay = await previous();
  if (replay) return replay;

  return withLease(deps.store, 'public-forms:contact:lease:' + scope, async () => {
    const raced = await previous();
    if (raced) return raced;
    const reference = contactReference();
    const receivedAt = (deps.now?.() ?? new Date()).toISOString();
    const written = await record(site, input, email, reference, request.origin, receivedAt);
    try { await deps.store.setValue(doneKey, JSON.stringify({ reference, fingerprint }), DONE_TTL_SEC); }
    catch { /* the CRM write is done; a replay would only attach one more Communication */ }
    logFormEvent('contact.recorded', {
      tenantId: site.tenantId, siteId: site.siteId, kind: site.kind, intent: input.intent,
      doctype: written.doctype, leadCreated: written.doctype === 'Lead' ? written.created : null, emailId, reference,
    });
    return { reference, replayed: false };
  });
}
