import { z } from 'zod';
import { frappeSite, FrappeSiteError } from '../marketplace-transactions/frappe-site.ts';
import { LinkPaySiteError, type VerifiedInvoice } from './frappe-site-routing.ts';

const reference = z.string().uuid();
export const RestaurantSourceSchema = z.object({
  attempt: reference,
  posProfile: z.string().min(1).max(140),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RestaurantSource = z.infer<typeof RestaurantSourceSchema>;
const snapshot = RestaurantSourceSchema.extend({
  order: z.string().min(1).max(140), company: z.string().min(1).max(140),
  currency: z.string().regex(/^[A-Z]{3}$/), amountMajor: z.string().regex(/^\d+(?:\.\d+)?$/),
  expiresAt: z.string().datetime({ offset: true }),
  state: z.enum(['Prepared', 'Claimed', 'Paid', 'Cancelled', 'Review']),
}).passthrough();

async function call(site: string, method: 'verify_attempt' | 'claim_attempt' | 'release_attempt',
  source: Pick<RestaurantSource, 'attempt' | 'posProfile'>, claimKey?: string) {
  try {
    const raw = await frappeSite(site).call(`konektag_360.link_pay.pos.${method}`, {
      attempt: source.attempt, pos_profile: source.posProfile,
      ...(claimKey !== undefined ? { claim_key: claimKey } : {}),
    });
    const result = snapshot.safeParse(raw);
    if (!result.success || result.data.attempt !== source.attempt || result.data.posProfile !== source.posProfile)
      throw new LinkPaySiteError('SOURCE_CONTRACT_INVALID', 503);
    return result.data;
  } catch (error) {
    if (error instanceof LinkPaySiteError) throw error;
    if (error instanceof FrappeSiteError && error.code === 'SITE_REJECTED')
      throw new LinkPaySiteError('SOURCE_NOT_COLLECTABLE', 409);
    throw new LinkPaySiteError('SOURCE_UNAVAILABLE', 503);
  }
}

export async function verifyRestaurantSource(site: string, attempt: unknown, posProfile: unknown) {
  const input = RestaurantSourceSchema.pick({ attempt: true, posProfile: true }).safeParse({ attempt, posProfile });
  if (!input.success) throw new LinkPaySiteError('SOURCE_REFERENCE_INVALID', 400);
  const doc = await call(site, 'verify_attempt', input.data);
  if (!['Prepared', 'Claimed', 'Paid'].includes(doc.state)) throw new LinkPaySiteError('SOURCE_NOT_COLLECTABLE', 409);
  const invoice: VerifiedInvoice = { name: doc.order, company: doc.company, currency: doc.currency, amountMajor: doc.amountMajor };
  return { invoice, source: { ...input.data, fingerprint: doc.fingerprint }, expiration: new Date(doc.expiresAt), state: doc.state };
}

export async function claimRestaurantSource(site: string, source: RestaurantSource, slug: string) {
  const doc = await call(site, 'claim_attempt', source, slug);
  if (doc.fingerprint !== source.fingerprint || doc.state !== 'Claimed')
    throw new LinkPaySiteError('SOURCE_NOT_COLLECTABLE', 409);
  return doc;
}

export const releaseRestaurantSource = (site: string, source: Pick<RestaurantSource, 'attempt' | 'posProfile'>, slug: string) =>
  call(site, 'release_attempt', source, slug);
