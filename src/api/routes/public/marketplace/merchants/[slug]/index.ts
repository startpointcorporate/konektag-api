import type { RequestContext } from '../../../../../http';
import { CACHED, defaultDeps, json, unavailable, type TransactionDeps } from '../../../../../../application/marketplace-transactions/http-handlers.ts';
import { isPublicSlugValue, toPublicProfile } from '../../../../../../application/marketplace-transactions/published-profiles.ts';

// Published Marketplace profile by slug (API #24). Read only.
// Absent and unpublished answer alike: a tombstone reveals nothing.
export const GET = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    const slug = ctx.params.slug ?? '';
    if (!isPublicSlugValue(slug)) return json({ error: 'PROFILE_NOT_FOUND' }, 404);
    deps ??= await defaultDeps();
    const row = await deps.profiles().bySlug(slug);
    if (!row || row.status !== 'Published') return json({ error: 'PROFILE_NOT_FOUND' }, 404);
    const p = toPublicProfile(row);
    return new Response(JSON.stringify({
      slug: p.slug, establishmentId: p.establishmentId, version: p.version, name: p.name, merchantName: p.merchantName,
      description: p.description, seoTitle: p.seoTitle, seoDescription: p.seoDescription, address: p.address, city: p.city,
      countryCode: p.countryCode, coordinates: p.coordinates, phone: p.phone, email: p.email, website: p.website, logo: p.logo,
      media: p.media, openingHours: p.openingHours, activities: p.activities, socialLinks: p.socialLinks,
      capabilities: p.capabilities, publishedAt: p.publishedAt,
    }), { status: 200, headers: CACHED });
  } catch (error) {
    const down = unavailable('profile', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
