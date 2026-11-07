/**
 * Marketplace read (API #24): one published establishment by slug, from the
 * PostgreSQL projection written by konektag_360 (migration 228).
 *
 * The snapshot is konektag_360.domain.snapshot(): only public fields of the
 * establishment and its merchant profile. Media are public Frappe files
 * (`/files/...`) of the source site, served from that site's origin.
 */

export type Capability = 'restaurant' | 'hotel';

export const isPublicSlugValue = (v: string) => v.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);

export interface ProjectionRow {
  establishment_id: string;
  source_site: string;
  slug: string;
  publication_version: number;
  status: 'Published' | 'Unpublished';
  snapshot: any;
  capabilities: string[];
  delivered_at: string | Date;
}

export interface PublishedProfiles {
  /** The projection row for this slug, published or not, or null. */
  bySlug(slug: string): Promise<ProjectionRow | null>;
}

export class ProjectionUnavailable extends Error {
  constructor() { super('PROJECTION_UNAVAILABLE'); }
}

type Query = (text: string, params: unknown[]) => Promise<{ rows: any[] }>;

/** SELECT-only reader; any database failure is reported as unavailable. */
export function sqlPublishedProfiles(query: Query): PublishedProfiles {
  return {
    async bySlug(slug) {
      try {
        const { rows } = await query(
          `SELECT establishment_id, source_site, slug, publication_version, status, snapshot, capabilities, delivered_at
             FROM konektag.marketplace_published_establishments WHERE slug = $1`, [slug]);
        return rows[0] ?? null;
      } catch {
        throw new ProjectionUnavailable();
      }
    },
  };
}

/** Published and carrying this capability; anything else is "not available". */
export async function publishedCapability(profiles: PublishedProfiles, slug: string, capability: Capability): Promise<boolean> {
  const row = await profiles.bySlug(slug);
  return !!row && row.status === 'Published' && row.capabilities.includes(capability);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const text = (v: unknown, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const hhmm = (v: unknown) => (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v) ? v.padStart(8, '0').slice(0, 5) : undefined);
const https = (v: unknown) => {
  const s = text(v, 500);
  if (!s) return undefined;
  try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
};

export interface PublicProfile {
  slug: string;
  establishmentId: string;
  version: number;
  name: string;
  merchantName?: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
  address?: string;
  city?: { id?: string; name?: string; slug?: string };
  countryCode?: string;
  coordinates?: { lat: number; lng: number };
  phone?: string;
  email?: string;
  website?: string;
  logo?: { url: string };
  media: { url: string; alt?: string; caption?: string }[];
  openingHours: { day: number; closed: boolean; opens?: string; closes?: string }[];
  activities: { code: string; name?: string }[];
  socialLinks: { platform: string; url: string }[];
  capabilities: Capability[];
  publishedAt: string;
}

export function toPublicProfile(row: ProjectionRow): PublicProfile {
  const s = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
  const m = s.merchant ?? {};
  const fileUrl = (path: unknown) => {
    // Only registered public files, as konektag_360 enforces at publication.
    if (typeof path !== 'string' || !path.startsWith('/files/') || path.includes('..')) return undefined;
    return new URL(path, `https://${row.source_site}`).href;
  };
  const lat = Number(s.latitude), lng = Number(s.longitude);
  const hasCoords = s.longitude !== null && s.longitude !== '' && s.longitude !== undefined && s.latitude !== null && s.latitude !== '' && s.latitude !== undefined && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const logo = fileUrl(m.logo);
  return {
    slug: row.slug,
    establishmentId: row.establishment_id,
    version: row.publication_version,
    name: text(s.establishment_name, 200) ?? row.slug,
    merchantName: text(m.merchant_name, 200),
    description: text(s.description) ?? text(m.description),
    seoTitle: text(m.seo_title, 200),
    seoDescription: text(m.seo_description, 320),
    address: text(s.address, 500),
    city: s.city_name || s.city_id ? { id: text(s.city_id, 120), name: text(s.city_name, 120), slug: text(s.city_slug, 120) } : undefined,
    countryCode: typeof s.country_code === 'string' && /^[A-Z]{2}$/.test(s.country_code) ? s.country_code : undefined,
    coordinates: hasCoords ? { lat, lng } : undefined,
    phone: text(m.public_phone, 40),
    email: text(m.public_email, 254),
    website: https(m.website),
    logo: logo ? { url: logo } : undefined,
    media: (s.media ?? []).map((r: any) => ({ url: fileUrl(r.file), alt: text(r.alt_text, 200), caption: text(r.caption, 300) }))
      .filter((r: any) => r.url),
    openingHours: (s.opening_hours ?? []).filter((r: any) => WEEKDAYS.includes(r.weekday)).map((r: any) => ({
      day: WEEKDAYS.indexOf(r.weekday), closed: !!Number(r.closed),
      ...(Number(r.closed) ? {} : { opens: hhmm(r.opens_at), closes: hhmm(r.closes_at) }),
    })),
    activities: (s.activities ?? []).filter((r: any) => text(r.activity_code, 80)).map((r: any) => ({ code: r.activity_code, name: text(r.activity_name, 120) })),
    socialLinks: (s.social_links ?? []).map((r: any) => ({ platform: text(r.platform, 40), url: https(r.url) }))
      .filter((r: any) => r.platform && r.url),
    capabilities: (row.capabilities ?? []).filter((c): c is Capability => c === 'restaurant' || c === 'hotel'),
    publishedAt: new Date(row.delivered_at).toISOString(),
  };
}
