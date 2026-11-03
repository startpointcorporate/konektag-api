/**
 * Canonical Marketplace slug and URL helpers.
 *
 * Isomorphic (no server dependencies): safe to import from Astro frontmatter,
 * API routes, middleware and bundled browser scripts.
 */
import type { ActivityCode } from '../../../domain/MerchantProfile.ts';
import { MerchantLocationRequiredError } from '../../../domain/MerchantErrors.ts';

/**
 * Canonical slug used for Marketplace URL segments (cities, merchants).
 *
 *   Douala → douala · Yaoundé → yaounde · Saint-Étienne → saint-etienne
 */
export function marketplaceSlug(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** City URL segment; a canonical Marketplace URL never has an empty city. */
function citySegment(city: string | null | undefined): string {
  const segment = marketplaceSlug(city);
  if (!segment) throw new MerchantLocationRequiredError(['city']);
  return segment;
}

/** N2 canonical route: `/{locale}/marketplace/{city}/{slug}/`. Throws without a city. */
export function marketplaceMerchantPath(locale: string, city: string | null | undefined, slug: string): string {
  return `/${locale}/marketplace/${citySegment(city)}/${slug}/`;
}

/** N3 canonical route: `/{locale}/marketplace/{city}/{activity}/{slug}/`. Throws without a city. */
export function marketplaceActivityPath(
  locale: string,
  city: string | null | undefined,
  activity: ActivityCode,
  slug: string,
): string {
  return `/${locale}/marketplace/${citySegment(city)}/${activity}/${slug}/`;
}
