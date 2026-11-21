import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RequestContext } from '../../api/http.ts';
import { FrappeSiteError, frappeSite, type FrappeSite } from '../marketplace-transactions/frappe-site.ts';
import { defaultPublicSiteResolver, publicSiteRequest, PublicSiteError, type PublicSiteScope } from './site-context.ts';

const selector = { site: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160).optional(), country: z.string().regex(/^[A-Za-z]{2}$/).optional() };
const allocation = z.object({ equipmentPool: z.string().trim().min(1).max(140), quantity: z.number().positive() }).strict();
export const availabilityInput = z.object({ ...selector, resource: z.string().trim().min(1).max(140), startsAt: z.string().datetime(), endsAt: z.string().datetime(), quantity: z.coerce.number().int().positive().max(100).default(1) }).strict();
export const bookingInput = z.object({ ...selector, resource: z.string().trim().min(1).max(140), startsAt: z.string().datetime(), endsAt: z.string().datetime(), allocations: z.array(allocation).max(30).default([]), opportunity: z.string().trim().min(1).max(140).optional(), quotation: z.string().trim().min(1).max(140).optional(), optionExpiresAt: z.string().datetime().optional(), mode: z.enum(['REQUEST', 'OPTION']).default('REQUEST') }).strict();
export const bookingChangeInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('RESCHEDULE'), accessToken: z.string().min(20).max(2000), startsAt: z.string().datetime(), endsAt: z.string().datetime(), resource: z.string().trim().min(1).max(140).optional() }).strict(),
  z.object({ action: z.literal('CANCEL'), accessToken: z.string().min(20).max(2000), reason: z.string().trim().max(500).optional() }).strict(),
]);
const line = z.object({ itemCode: z.string().trim().min(1).max(140), quantity: z.number().positive().max(100000), description: z.string().trim().max(1000).optional() }).strict();
export const quotationInput = z.object({ ...selector, lead: z.string().trim().min(1).max(140).optional(), opportunity: z.string().trim().min(1).max(140).optional(), currency: z.string().regex(/^[A-Z]{3}$/), priceList: z.string().trim().min(1).max(140), validTill: z.string().date().optional(), lines: z.array(line).min(1).max(100) }).strict().refine(v => Boolean(v.lead || v.opportunity), { message: 'lead or opportunity required' });

type CommerceConfig = { quotation?: boolean; booking?: boolean };
function configs(env: NodeJS.ProcessEnv): Record<string, CommerceConfig> {
  if (!env.PUBLIC_COMMERCE_SITES) return {};
  try {
    const value = JSON.parse(env.PUBLIC_COMMERCE_SITES);
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    return value;
  } catch { return {}; }
}
function enabled(siteId: string, scope: PublicSiteScope, env: NodeJS.ProcessEnv) {
  const config = configs(env)[siteId];
  return scope.startsWith('booking:') ? config?.booking === true : scope === 'quotation:write' ? config?.quotation === true : false;
}

export type CommerceDeps = { env: NodeJS.ProcessEnv; fetchImpl: typeof fetch; database?: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }; now: () => Date };
export const defaultCommerceDeps = (env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): CommerceDeps => ({ env, fetchImpl, now: () => new Date() });

export class CommerceError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
function secret(env: NodeJS.ProcessEnv) { const value = env.PUBLIC_COMMERCE_TOKEN_SECRET; if (!value || value.length < 32) throw new CommerceError('COMMERCE_NOT_CONFIGURED', 503); return value; }
function sign(payload: object, env: NodeJS.ProcessEnv) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret(env)).update(body).digest('base64url')}`;
}
function verify(token: string, expected: { siteId: string; kind: string; name: string }, env: NodeJS.ProcessEnv, now: Date) {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new CommerceError('ACCESS_DENIED', 403);
  const actual = Buffer.from(signature, 'base64url'); const wanted = createHmac('sha256', secret(env)).update(body).digest();
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new CommerceError('ACCESS_DENIED', 403);
  let value: any; try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw new CommerceError('ACCESS_DENIED', 403); }
  if (value.siteId !== expected.siteId || value.kind !== expected.kind || value.name !== expected.name || typeof value.exp !== 'number' || value.exp < now.getTime()) throw new CommerceError('ACCESS_DENIED', 403);
}

async function site(ctx: RequestContext, scope: PublicSiteScope, deps: CommerceDeps, selected?: { site?: string; country?: string }): Promise<{ siteId: string; frappe: FrappeSite }> {
  const resolver = defaultPublicSiteResolver({ isPublished: (id, operation) => enabled(id, operation, deps.env), env: deps.env, ...(deps.database ? { database: deps.database } : {}) });
  const resolved = await resolver.resolve(selected ? { ...selected, origin: ctx.request.headers.get('origin') } : publicSiteRequest(ctx.url.searchParams, ctx.request.headers), scope);
  try { return { siteId: resolved.siteId, frappe: frappeSite(resolved.frappeSiteKey, deps.env, deps.fetchImpl) }; }
  catch { throw new CommerceError('COMMERCE_NOT_CONFIGURED', 503); }
}
function dates(start: string, end: string) { if (Date.parse(end) <= Date.parse(start)) throw new CommerceError('INVALID_PERIOD', 422); }
function bookingView(value: any) { return { reference: value.name, resource: value.resource, startsAt: value.starts_at, endsAt: value.ends_at, status: value.status, optionExpiresAt: value.option_expires_at ?? null, quotation: value.quotation ?? null }; }
function quotationView(value: any) { return { reference: value.name, status: Number(value.docstatus) === 0 ? 'DRAFT' : Number(value.docstatus) === 1 ? 'SUBMITTED' : 'CANCELLED', currency: value.currency, priceList: value.selling_price_list, netTotal: value.net_total, totalTaxesAndCharges: value.total_taxes_and_charges, grandTotal: value.grand_total }; }

export async function availability(ctx: RequestContext, input: z.infer<typeof availabilityInput>, deps: CommerceDeps) {
  dates(input.startsAt, input.endsAt); const target = await site(ctx, 'booking:read', deps, input);
  const value = await target.frappe.call('konektag_abm.api.availability', { resource: input.resource, starts_at: input.startsAt, ends_at: input.endsAt, quantity: input.quantity });
  return { site: target.siteId, resource: input.resource, startsAt: input.startsAt, endsAt: input.endsAt, available: Boolean(value.available), occupied: Boolean(value.occupied) };
}
export async function createBooking(ctx: RequestContext, input: z.infer<typeof bookingInput>, key: string, deps: CommerceDeps) {
  if (!key || key.length > 140) throw new CommerceError('IDEMPOTENCY_KEY_REQUIRED', 422); dates(input.startsAt, input.endsAt);
  const target = await site(ctx, 'booking:write', deps, input);
  const payload: any = { resource: input.resource, starts_at: input.startsAt, ends_at: input.endsAt, allocations: input.allocations.map(v => ({ equipment_pool: v.equipmentPool, quantity: v.quantity })), ...(input.opportunity ? { opportunity: input.opportunity } : {}), ...(input.quotation ? { quotation: input.quotation } : {}), ...(input.optionExpiresAt ? { option_expires_at: input.optionExpiresAt } : {}) };
  let value = await target.frappe.call('konektag_abm.api.create_booking', { payload, idempotency_key: key });
  if (input.mode === 'OPTION' && value.status === 'Request') value = await target.frappe.call('konektag_abm.api.transition', { name: value.name, target_status: 'Option' });
  return { ...bookingView(value), accessToken: sign({ siteId: target.siteId, kind: 'booking', name: value.name, exp: deps.now().getTime() + 30 * 86400000 }, deps.env) };
}
export async function changeBooking(ctx: RequestContext, name: string, input: z.infer<typeof bookingChangeInput>, deps: CommerceDeps) {
  const target = await site(ctx, 'booking:write', deps); verify(input.accessToken, { siteId: target.siteId, kind: 'booking', name }, deps.env, deps.now());
  const value = input.action === 'CANCEL'
    ? await target.frappe.call('konektag_abm.api.transition', { name, target_status: 'Cancelled', ...(input.reason ? { reason: input.reason } : {}) })
    : (dates(input.startsAt, input.endsAt), await target.frappe.call('konektag_abm.api.reschedule', { name, starts_at: input.startsAt, ends_at: input.endsAt, ...(input.resource ? { resource: input.resource } : {}) }));
  return bookingView(value);
}
export async function createQuotation(ctx: RequestContext, input: z.infer<typeof quotationInput>, deps: CommerceDeps) {
  const target = await site(ctx, 'quotation:write', deps, input);
  let lead = input.lead;
  if (!lead) {
    const opportunity = await target.frappe.get('Opportunity', input.opportunity!);
    if (opportunity.opportunity_from !== 'Lead' || typeof opportunity.party_name !== 'string' || !opportunity.party_name)
      throw new CommerceError('OPPORTUNITY_NOT_PUBLIC_LEAD', 422);
    lead = opportunity.party_name;
  }
  const doc = await target.frappe.insert('Quotation', { quotation_to: 'Lead', party_name: lead, ...(input.opportunity ? { opportunity: input.opportunity } : {}), currency: input.currency, selling_price_list: input.priceList, ...(input.validTill ? { valid_till: input.validTill } : {}), items: input.lines.map(v => ({ item_code: v.itemCode, qty: v.quantity, ...(v.description ? { description: v.description } : {}) })) });
  return { ...quotationView(doc), accessToken: sign({ siteId: target.siteId, kind: 'quotation', name: doc.name, exp: deps.now().getTime() + 30 * 86400000 }, deps.env) };
}
export async function getQuotation(ctx: RequestContext, name: string, token: string, deps: CommerceDeps) {
  const target = await site(ctx, 'quotation:write', deps); verify(token, { siteId: target.siteId, kind: 'quotation', name }, deps.env, deps.now());
  return quotationView(await target.frappe.get('Quotation', name));
}
export function commerceFailure(error: unknown): Response {
  if (error instanceof PublicSiteError || error instanceof CommerceError) return Response.json({ error: error.code }, { status: error instanceof PublicSiteError ? error.httpStatus : error.status, headers: { 'Cache-Control': 'no-store' } });
  if (error instanceof FrappeSiteError) {
    if (error.excType === 'DoesNotExistError' || /not found|does not exist|could not find/i.test(error.serverMessage ?? '')) return Response.json({ error: 'FEATURE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const conflict = error.httpStatus === 409 || /overlap|capacity|available|idempotency key/i.test(error.serverMessage ?? '');
    return Response.json({ error: conflict ? 'BOOKING_CONFLICT' : error.code === 'SITE_REJECTED' ? 'REQUEST_REJECTED' : 'COMMERCE_UNAVAILABLE' }, { status: conflict ? 409 : error.code === 'SITE_REJECTED' ? 422 : 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json({ error: 'COMMERCE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
