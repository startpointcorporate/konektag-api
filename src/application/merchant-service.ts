import {NATIVE_CATALOG_RETIRED} from '../domain/native-catalog-retirement.ts';
import { ActivityCodeSchema, setActivityPublication, upsertActivityProfile, type RestaurantSchema, type HotelSchema, type CommerceSchema } from './merchant-activity-profile.ts';
import type { z } from 'zod';
import {validateMerchantMedia} from './shared/media-validation.ts';
import { currencyForCountry } from './services/operation-currency-service.ts';
import { requireEntitlement } from './services/entitlement-decision-service.ts';
import pool from '../infrastructure/database/pool.ts';
import { requireCoreMerchantActor } from './core-transaction-service.ts';
import { getCorrelationId } from '../infrastructure/correlation-id.ts';
import { merchantMediaStorage, type FileInput } from '../infrastructure/media-storage.ts';
import { qrcodeService } from './qrcode-service.ts';
import type {
  MerchantProfile, CreateMerchantProfileInput, UpdateMerchantProfileInput,
  MerchantMedia, MerchantExternalLink, MerchantOpeningHour,
  RestaurantProfile, HotelProfile, CommerceProfile, MerchantProduct,
  ActivityCode, ActivityType, CertificationStatus, CertificationDocument, CertificationDossier,
  CertificationDocumentType,
} from '../domain/MerchantProfile.ts';
import { MerchantCannotPublishError, MerchantProfileNotFoundError, MerchantNotOwnerError, MerchantSlugTakenError, MerchantInvalidUrlError, MerchantCertificationIncompleteError, MerchantCertificationTransactionsInsufficientError, MerchantAlreadyCertifiedError } from '../domain/MerchantErrors.ts';
import { marketplaceMerchantPath, marketplaceSlug } from './shared/marketplace/slug.ts';
import { hasMerchantLocation, requireMerchantLocation } from '../domain/MerchantLocation.ts';

function slugify(text: string): string {
  return marketplaceSlug(text).slice(0, 200);
}

function mapRow(row: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!row) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    result[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = row[key];
  }
  return result;
}

function mapRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(r => mapRow(r)!);
}

async function loadFullProfile(profileId: string, db: Pick<typeof pool, 'query'> = pool): Promise<MerchantProfile> {
  const { rows: [p] } = await db.query(`SELECT * FROM konektag.merchant_profiles WHERE id = $1`, [profileId]);
  if (!p) throw new MerchantProfileNotFoundError(profileId);
  const profile = mapRow(p)! as unknown as MerchantProfile;
  const { rows: media } = await db.query(`SELECT * FROM konektag.merchant_media WHERE merchant_profile_id = $1 AND deleted_at IS NULL ORDER BY display_order`, [profileId]);
  const { rows: links } = await db.query(`SELECT * FROM konektag.merchant_external_links WHERE merchant_profile_id = $1 AND deleted_at IS NULL ORDER BY display_order`, [profileId]);
  const { rows: hours } = await db.query(`SELECT * FROM konektag.merchant_opening_hours WHERE merchant_profile_id = $1 AND deleted_at IS NULL ORDER BY day_of_week`, [profileId]);
  const { rows: [resto] } = await db.query(`SELECT * FROM konektag.restaurant_profiles WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [profileId]);
  const { rows: [hotel] } = await db.query(`SELECT * FROM konektag.hotel_profiles WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [profileId]);
  const { rows: [commerce] } = await db.query(`SELECT * FROM konektag.commerce_profiles WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [profileId]);
  const { rows: products } = await db.query(`SELECT p.*, p.offer_category_id AS "offerCategoryId", p.offer_subcategory_id AS "offerSubcategoryId",
    oc.code AS "categoryCode", oc.name_i18n AS "categoryNameI18n", osc.code AS "subcategoryCode", osc.name_i18n AS "subcategoryNameI18n"
    FROM konektag.merchant_products p
    JOIN konektag.offer_categories oc ON oc.id=p.offer_category_id AND oc.deleted_at IS NULL
    LEFT JOIN konektag.offer_subcategories osc ON osc.id=p.offer_subcategory_id AND osc.deleted_at IS NULL
    WHERE p.merchant_profile_id = $1 AND p.deleted_at IS NULL ORDER BY p.display_order`, [profileId]);
  const result: any = {
    ...profile,
    media: mapRows(media) as unknown as MerchantMedia[],
    externalLinks: mapRows(links) as unknown as MerchantExternalLink[],
    openingHours: mapRows(hours) as unknown as MerchantOpeningHour[],
    restaurantProfile: resto ? mapRow(resto) as unknown as RestaurantProfile : undefined,
    hotelProfile: hotel ? mapRow(hotel) as unknown as HotelProfile : undefined,
    commerceProfile: commerce ? mapRow(commerce) as unknown as CommerceProfile : undefined,
    products: mapRows(products) as unknown as MerchantProduct[],
  };
  if (p.certification_status) result.certificationStatus = p.certification_status;
  if (p.certification_submitted_at) result.certificationSubmittedAt = p.certification_submitted_at;
  if (p.certification_reviewed_at) result.certificationReviewedAt = p.certification_reviewed_at;
  if (p.certification_reviewed_by) result.certificationReviewedBy = p.certification_reviewed_by;

  if (!result.qrCodeUrl && result.userId) {
    try {
      const { rows: [localeRow] } = await db.query(`SELECT locale FROM konektag.users WHERE id = $1`, [result.userId]);
      const locale = localeRow?.locale ?? 'fr';
      // Marketplace QR only for a valid location: never point to a URL without a city.
      if (hasMerchantLocation(result)) {
        const publicPageUrl = marketplaceMerchantPath(locale, result.city, result.slug);
        result.qrCodeDataUrl = await qrcodeService.generateQrCodeDataUrl(`https://konektag.io${publicPageUrl}`);
        if (!result.publicPageUrl) {
          result.publicPageUrl = publicPageUrl;
        }
      }
      // Payment QR: scannable by the Konektag app to initiate payment
      const paymentData = JSON.stringify({
        type: 'qr_payment',
        ownerUserId: result.userId,
        merchant: result.businessName,
        amount: 0,
        currency: currencyForCountry(result.country),
        reference: result.slug,
      });
      if (p.kyb_status === 'MERCHANT_APPROVED' && p.status !== 'Suspended') {
        result.qrCodePaymentDataUrl = await qrcodeService.generateQrCodeDataUrl(paymentData);
      }
    } catch (e) {
      console.error('[merchant] Failed to generate QR code:', e);
    }
  }
  return result as MerchantProfile;
}

export class MerchantService {

  async requireOwnerOrManager(merchantProfileId: string, actorUserId: string): Promise<void> {
    const { rows } = await pool.query(
      `SELECT 1
       FROM konektag.merchant_profiles mp
       LEFT JOIN konektag.merchant_memberships mm
         ON mm.merchant_profile_id = mp.id
        AND mm.user_id = $2
        AND mm.status = 'active'
        AND mm.role IN ('owner', 'manager')
       WHERE mp.id = $1
         AND mp.deleted_at IS NULL
         AND (mp.user_id = $2 OR mm.user_id IS NOT NULL)
       LIMIT 1`,
      [merchantProfileId, actorUserId],
    );
    if (!rows[0]) throw new MerchantNotOwnerError();
  }

  async createProfile(userId: string, input: CreateMerchantProfileInput): Promise<MerchantProfile> {
    const location = requireMerchantLocation(input);
    const slug = slugify(input.businessName);

    let uniqueSlug = slug;
    const { rows: [existingSlug] } = await pool.query(`SELECT id FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
    if (existingSlug) uniqueSlug = `${slug}-${Date.now().toString(36)}`;

    const correlationId = getCorrelationId();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [p] } = await client.query(
        `INSERT INTO konektag.merchant_profiles (business_name, slug, short_description, long_description, address, city, country, phone, email, website_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [input.businessName, uniqueSlug, input.shortDescription ?? null, input.longDescription ?? null,
         input.address ?? null, location.city, location.country,
         input.phone ?? null, input.email ?? null, input.websiteUrl ?? null],
      );

      // Créer la membership owner
      await client.query(
        `INSERT INTO konektag.merchant_memberships (merchant_profile_id, user_id, role, status, is_primary, approved_at, created_by)
         VALUES ($1, $2, 'owner', 'active', true, now(), $3)
         ON CONFLICT (merchant_profile_id, user_id) DO UPDATE SET status = 'active', is_primary = true, removed_at = NULL`,
        [p.id, userId, userId],
      );

      // Backfill merchant_profiles.user_id pour compatibilité legacy
      await client.query(`UPDATE konektag.merchant_profiles SET user_id = $1 WHERE id = $2`, [userId, p.id]);

      await client.query(
        `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
        [userId, correlationId, 'MERCHANT_CREATED', { profileId: p.id, businessName: input.businessName }],
      );

      await client.query('COMMIT');
      // p was returned before the legacy user_id backfill; return the canonical
      // persisted profile so callers immediately see the owner association.
      return loadFullProfile(p.id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async claimProfile(userId: string, slug: string): Promise<{ status: string; businessName: string; slug: string }> {
    const { rows: [p] } = await pool.query(`SELECT * FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
    if (!p) throw new MerchantProfileNotFoundError(slug);
    if (p.status !== 'Referenced') throw new Error('Ce commerce ne peut pas être réclamé');
    if (p.user_id) throw new Error('Ce commerce est déjà associé à un autre compte');
    requireMerchantLocation(p);

    // Vérifier si une demande existe déjà
    const { rows: [existingClaim] } = await pool.query(
      `SELECT id, status FROM konektag.merchant_claims WHERE merchant_profile_id = $1 AND user_id = $2`,
      [p.id, userId],
    );
    if (existingClaim) {
      if (existingClaim.status === 'pending') throw new Error('Une demande est déjà en attente pour ce commerce.');
      if (existingClaim.status === 'approved') throw new Error('Ce commerce est déjà associé à votre compte.');
      if (existingClaim.status === 'rejected') throw new Error('Votre demande a été refusée. Contactez le support.');
    }

    // Créer la demande en attente
    await pool.query(
      `INSERT INTO konektag.merchant_claims (merchant_profile_id, user_id, status) VALUES ($1, $2, 'pending')`,
      [p.id, userId],
    );

    const correlationId = getCorrelationId();
    await pool.query(`INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
      [userId, correlationId, 'MERCHANT_CLAIM_REQUESTED', { profileId: p.id, slug: p.slug }]);

    return { status: 'pending', businessName: p.business_name, slug: p.slug };
  }

  async approveClaim(claimId: string, adminUserId: string): Promise<void> {
    const { rows: [claim] } = await pool.query(`SELECT * FROM konektag.merchant_claims WHERE id = $1 AND status = 'pending'`, [claimId]);
    if (!claim) throw new Error('Demande introuvable ou déjà traitée');

    const correlationId = getCorrelationId();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [target] } = await client.query(
        `SELECT city, country FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [claim.merchant_profile_id],
      );
      if (!target) throw new MerchantProfileNotFoundError(claim.merchant_profile_id);
      requireMerchantLocation(target);

      // Créer ou réactiver la membership du réclamant
      await client.query(
        `INSERT INTO konektag.merchant_memberships (merchant_profile_id, user_id, role, status, is_primary, approved_at, created_by)
         VALUES ($1, $2, 'owner', 'active', true, now(), $3)
         ON CONFLICT (merchant_profile_id, user_id) DO UPDATE SET status = 'active', is_primary = true, role = 'owner', removed_at = NULL, approved_at = now()`,
        [claim.merchant_profile_id, claim.user_id, adminUserId],
      );

      // Backfill merchant_profiles.user_id pour compatibilité legacy
      await client.query(
        `UPDATE konektag.merchant_profiles SET user_id = $1, updated_at = now(), version = version + 1 WHERE id = $2 AND deleted_at IS NULL`,
        [claim.user_id, claim.merchant_profile_id],
      );

      await client.query(
        `UPDATE konektag.merchant_claims SET status = 'approved', reviewed_at = now(), reviewed_by = $1 WHERE id = $2`,
        [adminUserId, claimId],
      );
      await client.query(
        `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
        [adminUserId, correlationId, 'MERCHANT_CLAIM_APPROVED', { claimId, profileId: claim.merchant_profile_id, userId: claim.user_id }],
      );
      await client.query(
        `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'MerchantProfile', $2, 'MerchantClaimApproved', 1, $3)`,
        [correlationId, claim.merchant_profile_id, JSON.stringify({
          merchantId: claim.merchant_profile_id,
          userId: claim.user_id,
        })],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async rejectClaim(claimId: string, adminUserId: string): Promise<void> {
    const { rows: [claim] } = await pool.query(`SELECT * FROM konektag.merchant_claims WHERE id = $1 AND status = 'pending'`, [claimId]);
    if (!claim) throw new Error('Demande introuvable ou déjà traitée');

    await pool.query(
      `UPDATE konektag.merchant_claims SET status = 'rejected', reviewed_at = now(), reviewed_by = $1 WHERE id = $2`,
      [adminUserId, claimId],
    );

    const correlationId = getCorrelationId();
    await pool.query(`INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
      [adminUserId, correlationId, 'MERCHANT_CLAIM_REJECTED', { claimId, profileId: claim.merchant_profile_id, userId: claim.user_id }]);
  }

  async getPendingClaims(): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.created_at,
              mp.id as merchant_id, mp.business_name, mp.slug, mp.city, mp.country,
              u.id as user_id, u.username
       FROM konektag.merchant_claims c
       JOIN konektag.merchant_profiles mp ON mp.id = c.merchant_profile_id
       JOIN konektag.users u ON u.id = c.user_id AND u.deleted_at IS NULL
       WHERE c.status = 'pending'
         AND mp.deleted_at IS NULL
       ORDER BY c.created_at DESC`,
    );
    return rows.map((r: any) => ({
      id: r.id,
      status: r.status,
      createdAt: r.created_at,
      merchant: { id: r.merchant_id, businessName: r.business_name, slug: r.slug, city: r.city, country: r.country },
      user: { id: r.user_id, username: r.username, email: null },
    }));
  }

  async getProfilesByUserId(userId: string): Promise<MerchantProfile[]> {
    const { rows } = await pool.query(
      `SELECT mp.id FROM konektag.merchant_profiles mp
       JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id
       WHERE mm.user_id = $1 AND mm.status = 'active' AND mp.deleted_at IS NULL
       ORDER BY mp.created_at DESC`,
      [userId],
    );
    return Promise.all(rows.map((r: any) => loadFullProfile(r.id)));
  }

  async getAssignmentRequestsByUserId(userId: string): Promise<Array<{
    id: string;
    status: 'pending' | 'rejected';
    createdAt: string;
    reviewedAt: string | null;
    businessName: string;
    slug: string;
    city: string | null;
    country: string | null;
  }>> {
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.created_at, c.reviewed_at,
              mp.business_name, mp.slug, mp.city, mp.country
       FROM konektag.merchant_claims c
       JOIN konektag.merchant_profiles mp ON mp.id = c.merchant_profile_id
       WHERE c.user_id = $1 AND c.status IN ('pending', 'rejected')
       ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC`,
      [userId],
    );
    return rows.map((row: any) => ({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      businessName: row.business_name,
      slug: row.slug,
      city: row.city,
      country: row.country,
    }));
  }

  /**
   * Résolution unique et déterministe du profil d'un marchand :
   * membership primaire d'abord, puis plus récent, avec fallback user_id legacy.
   * Toutes les méthodes de mutation DOIVENT l'utiliser (comptes multi-fiches).
   */
  private async resolveProfile(userId: string): Promise<any> {
    const { rows: [p] } = await pool.query(
      `SELECT mp.* FROM konektag.merchant_profiles mp
       LEFT JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id AND mm.user_id = $1 AND mm.status = 'active'
       WHERE (mm.id IS NOT NULL OR mp.user_id = $1) AND mp.deleted_at IS NULL
       ORDER BY mm.is_primary DESC, mp.created_at DESC LIMIT 1`,
      [userId],
    );
    if (!p) throw new MerchantProfileNotFoundError(userId);
    return p;
  }

  async getProfile(userId: string): Promise<MerchantProfile> {
    const p = await this.resolveProfile(userId);
    return loadFullProfile(p.id);
  }

  async getProfileBySlug(slug: string): Promise<MerchantProfile | null> {
    const { rows: [p] } = await pool.query(`SELECT * FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
    if (!p) {
      const { rows: [old] } = await pool.query(`SELECT merchant_profile_id FROM konektag.merchant_slug_history WHERE old_slug = $1 LIMIT 1`, [slug]);
      if (old) {
        const { rows: [redirected] } = await pool.query(`SELECT * FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [old.merchant_profile_id]);
        if (redirected && redirected.status === 'Published') return loadFullProfile(redirected.id);
      }
      return null;
    }
    if (p.status !== 'Published' && p.status !== 'Referenced' && p.status !== 'Draft') return null;
    return loadFullProfile(p.id);
  }

  async updateProfile(userId: string, input: UpdateMerchantProfileInput & { profileId?: string }): Promise<MerchantProfile> {
    let p: any;
    if (input.profileId) {
      const { rows: [found] } = await pool.query(`SELECT * FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [input.profileId]);
      if (!found) throw new MerchantNotOwnerError();
      await this.requireOwnerOrManager(input.profileId, userId);
      p = found;
    } else {
      p = await this.resolveProfile(userId);
    }

    const locationChange = input.city !== undefined || input.country !== undefined;
    const location = locationChange
      ? requireMerchantLocation({
        city: input.city !== undefined ? input.city : p.city,
        country: input.country !== undefined ? input.country : p.country,
      })
      : null;

    if (input.businessName && input.businessName !== p.business_name) {
      const newSlug = slugify(input.businessName);
      const { rows: [dupSlug] } = await pool.query(`SELECT id FROM konektag.merchant_profiles WHERE slug = $1 AND id != $2 AND deleted_at IS NULL`, [newSlug, p.id]);
      if (dupSlug) throw new MerchantSlugTakenError(newSlug);
      await pool.query(`INSERT INTO konektag.merchant_slug_history (merchant_profile_id, old_slug) VALUES ($1,$2)`, [p.id, p.slug]);
      await pool.query(`UPDATE konektag.merchant_profiles SET business_name = $1, slug = $2 WHERE id = $3`, [input.businessName, newSlug, p.id]);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const settable: [string, keyof UpdateMerchantProfileInput, string][] = [
      ['short_description', 'shortDescription', 'shortDescription'],
      ['long_description', 'longDescription', 'longDescription'],
      ['address', 'address', 'address'],
      ['city', 'city', 'city'],
      ['country', 'country', 'country'],
      ['neighborhood', 'neighborhood', 'neighborhood'],
      ['phone', 'phone', 'phone'],
      ['email', 'email', 'email'],
      ['website_url', 'websiteUrl', 'websiteUrl'],
      ['seo_title', 'seoTitle', 'seoTitle'],
      ['seo_description', 'seoDescription', 'seoDescription'],
      ['seo_canonical_url', 'seoCanonicalUrl', 'seoCanonicalUrl'],
      ['og_title', 'ogTitle', 'ogTitle'],
      ['og_description', 'ogDescription', 'ogDescription'],
      ['og_image_url', 'ogImageUrl', 'ogImageUrl'],
      ['logo_url', 'logoUrl', 'logoUrl'],
      ['cover_image_url', 'coverImageUrl', 'coverImageUrl'],
      ['latitude', 'latitude', 'latitude'],
      ['longitude', 'longitude', 'longitude'],
    ];

    for (const [col, key] of settable) {
      if (input[key] !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(location && (key === 'city' || key === 'country') ? location[key] : input[key]);
      }
    }

    if (fields.length > 0) {
      values.push(p.id);
      await pool.query(`UPDATE konektag.merchant_profiles SET ${fields.join(', ')}, version = version + 1 WHERE id = $${idx}`,
        values);
    }

    return this.getProfile(userId);
  }

  private async saveEstablishmentSnapshot(db: Pick<typeof pool,'query'>, draft: MerchantProfile, userId:string):Promise<void> {
    const snapshot = {
      schemaVersion: 1,
      merchant: {
        id:draft.id,businessName:draft.businessName,slug:draft.slug,logoUrl:draft.logoUrl,coverImageUrl:draft.coverImageUrl,
        shortDescription:draft.shortDescription,longDescription:draft.longDescription,address:draft.address,city:draft.city,cityId:(draft as any).cityId,country:draft.country,
        neighborhood:draft.neighborhood,phone:draft.phone,email:draft.email,websiteUrl:draft.websiteUrl,latitude:draft.latitude,longitude:draft.longitude,
        certificationStatus:draft.certificationStatus,photoUrls:(draft as any).photoUrls,
        seoTitle:draft.seoTitle,seoDescription:draft.seoDescription,seoCanonicalUrl:draft.seoCanonicalUrl,
        ogTitle:draft.ogTitle,ogDescription:draft.ogDescription,ogImageUrl:draft.ogImageUrl,
      },
      activities: [
        draft.restaurantProfile?.status === 'Published' || draft.restaurantProfile?.status === 'Referenced' ? 'Restaurant' : null,
        draft.hotelProfile?.status === 'Published' || draft.hotelProfile?.status === 'Referenced' ? 'Hotel' : null,
        draft.commerceProfile?.status === 'Published' || draft.commerceProfile?.status === 'Referenced' ? 'Commerce' : null,
      ].filter(Boolean),
    };
    await db.query(`INSERT INTO konektag.merchant_n2_publication_snapshots(merchant_profile_id,version,snapshot,published_by)
      SELECT $1,COALESCE(MAX(version),0)+1,$2::jsonb,$3 FROM konektag.merchant_n2_publication_snapshots WHERE merchant_profile_id=$1`,
      [draft.id,JSON.stringify(snapshot),userId]);
  }

  async publishEstablishment(userId: string, merchantProfileId?: string): Promise<MerchantProfile> {
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    requireMerchantLocation(p);
    const db=await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const {rows:[current]}=await db.query('SELECT * FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[p.id]);
      if(!current)throw new MerchantProfileNotFoundError(p.id);
      requireMerchantLocation(current);
      if(current.status==='Suspended')throw new MerchantCannotPublishError('Establishment is suspended');
      if(!current.business_name)throw new MerchantCannotPublishError('Missing required establishment name');
      const draft=await loadFullProfile(p.id,db);
      await this.saveEstablishmentSnapshot(db,draft,userId);
      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;} finally{db.release();}
    return loadFullProfile(p.id);
  }

  async publishProfile(userId: string, activityCode: ActivityCode, merchantProfileId?: string): Promise<MerchantProfile> {
    const code = ActivityCodeSchema.parse(activityCode);
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    return this.publishResolvedProfile(userId,code,p);
  }

  async publishProfileAsAdmin(userId:string,activityCode:ActivityCode,profileId:string):Promise<MerchantProfile> {
    const code=ActivityCodeSchema.parse(activityCode);
    const {rows:[admin]}=await pool.query("SELECT id FROM konektag.users WHERE id=$1 AND role='admin' AND deleted_at IS NULL",[userId]);
    if(!admin)throw new MerchantNotOwnerError();
    const {rows:[p]}=await pool.query('SELECT * FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL',[profileId]);
    if(!p)throw new MerchantProfileNotFoundError(profileId);
    return this.publishResolvedProfile(userId,code,p);
  }

  private async publishResolvedProfile(userId:string,code:ActivityCode,p:any):Promise<MerchantProfile> {
    const location = requireMerchantLocation(p);
    const db=await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const {rows:[current]}=await db.query('SELECT * FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[p.id]);
      if(!current)throw new MerchantProfileNotFoundError(p.id);
      requireMerchantLocation(current);
      // Marketplace publication is independent of legacy product data and the Pro subscription.
      await setActivityPublication(db, current, code, true);

      // Publication is an explicit Draft -> Live boundary. The editor keeps mutable
      // working data; the marketplace reads this immutable public snapshot.
      const draft = await loadFullProfile(p.id,db);
      const activity = code === 'Restaurant' ? draft.restaurantProfile
        : code === 'Hotel' ? draft.hotelProfile : draft.commerceProfile;
      const resolvedActivity = {
        ...(activity as any),
        shortDescription: (activity as any)?.shortDescription ?? draft.shortDescription,
        longDescription: (activity as any)?.longDescription ?? draft.longDescription,
        phone: (activity as any)?.phone ?? draft.phone,
        email: (activity as any)?.email ?? draft.email,
      };
      const resolvedHours = (() => {
        const all = draft.openingHours ?? [];
        const specific = all.filter(h => h.activityCode === code);
        if (!specific.length) return all.filter(h => h.activityCode == null).map(h => ({ ...h, activityCode: code }));
        const byDay = new Map(specific.map(h => [h.dayOfWeek, h]));
        return all.filter(h => h.activityCode == null).map(h => byDay.get(h.dayOfWeek) ?? ({ ...h, activityCode: code }))
          .concat(specific.filter(h => !all.some(g => g.activityCode == null && g.dayOfWeek === h.dayOfWeek)));
      })();
      const snapshot = {
        schemaVersion: 2,
        merchant: {
          id: draft.id, userId: draft.userId, businessName: draft.businessName, slug: draft.slug,
          logoUrl: draft.logoUrl, coverImageUrl: draft.coverImageUrl,
          shortDescription: draft.shortDescription, longDescription: draft.longDescription,
          address: draft.address, city: draft.city, country: draft.country, neighborhood: draft.neighborhood,
          phone: draft.phone, email: draft.email, websiteUrl: draft.websiteUrl,
          latitude: draft.latitude, longitude: draft.longitude,
          certificationStatus: draft.certificationStatus, qrCodeUrl: draft.qrCodeUrl,
          publicPageUrl: draft.publicPageUrl,
          seoTitle: draft.seoTitle, seoDescription: draft.seoDescription, seoCanonicalUrl: draft.seoCanonicalUrl,
          ogTitle: draft.ogTitle, ogDescription: draft.ogDescription, ogImageUrl: draft.ogImageUrl,
        },
        activityCode: code,
        activity: resolvedActivity,
        media: draft.media ?? [],
        externalLinks: draft.externalLinks ?? [],
        openingHours: resolvedHours,
        products: draft.products ?? [],
      };
      await db.query(
        `INSERT INTO konektag.merchant_publication_snapshots
         (merchant_profile_id, activity_code, version, snapshot, published_by)
         SELECT $1, $2::varchar, COALESCE(MAX(version),0)+1, $3::jsonb, $4
         FROM konektag.merchant_publication_snapshots
         WHERE merchant_profile_id=$1 AND activity_code=$2::varchar`,
        [p.id, code, JSON.stringify(snapshot), userId],
      );

      await this.saveEstablishmentSnapshot(db,draft,userId);

      await db.query('COMMIT');
    } catch(error){await db.query('ROLLBACK');throw error;} finally{db.release();}

    const publicPageUrl = marketplaceMerchantPath(p.locale ?? 'fr', location.city, p.slug);
    const { rows: [localeRow] } = await pool.query(`SELECT locale FROM konektag.users WHERE id = $1`, [userId]);
    const locale = localeRow?.locale ?? 'fr';

    try {
      const qrBuff = await qrcodeService.generateQrCodeBuffer(`https://konektag.io${publicPageUrl}`);
      const { url: qrUrl } = await merchantMediaStorage.uploadQrCode(p.id, qrBuff);
      await pool.query(`UPDATE konektag.merchant_profiles SET qr_code_url = $1, public_page_url = $2 WHERE id = $3`, [qrUrl, publicPageUrl, p.id]);
    } catch (error) {
      // Public pages render their visibility QR on demand; storage failure does not undo publication.
      console.error('[merchant] Visibility QR storage unavailable after publication:', error);
    }

    const correlationId = getCorrelationId();
    await pool.query(`INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
      [userId, correlationId, 'MERCHANT_PUBLISHED', { profileId: p.id, slug: p.slug, activityCode: code }]);

    return loadFullProfile(p.id);
  }

  async unpublishProfile(userId: string, activityCode: ActivityCode, merchantProfileId?: string): Promise<MerchantProfile> {
    const code = ActivityCodeSchema.parse(activityCode);
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    await setActivityPublication(pool, p, code, false);
    return loadFullProfile(p.id);
  }

  async uploadMedia(userId: string, merchantProfileId: string, file: FileInput, title?: string, description?: string): Promise<MerchantMedia> {
    const p = await this.resolveManagedProfile(userId, merchantProfileId);

    validateMerchantMedia(file.buffer,file.mimeType,file.originalName);
    const accessClient=await pool.connect();try{await requireCoreMerchantActor(accessClient,p.id,userId);}finally{accessClient.release();}
    const { url } = await merchantMediaStorage.uploadMedia(p.id, file);

    const mediaType = file.mimeType.startsWith('image/') ? 'Image'
      : file.mimeType === 'application/pdf' ? 'Pdf'
      : file.mimeType.startsWith('audio/') ? 'Audio'
      : 'Video';

    const { rows: [count] } = await pool.query(`SELECT COUNT(*) as cnt FROM konektag.merchant_media WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [p.id]);
    const nextOrder = parseInt(count.cnt, 10);

    const { rows: [media] } = await pool.query(
      `INSERT INTO konektag.merchant_media (merchant_profile_id, media_type, title, description, file_url, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [p.id, mediaType, title ?? null, description ?? null, url, nextOrder],
    );

    if (mediaType === 'Image' && (!p.cover_image_url || p.cover_image_url === '')) {
      await pool.query(
        `UPDATE konektag.merchant_profiles SET cover_image_url = $1, version = version + 1 WHERE id = $2`,
        [url, p.id],
      );
    }
    return mapRow(media) as unknown as MerchantMedia;
  }

  async deleteMedia(userId: string, merchantProfileId: string, mediaId: string): Promise<void> {
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    await pool.query(`UPDATE konektag.merchant_media SET deleted_at = now() WHERE id = $1 AND merchant_profile_id = $2`, [mediaId, p.id]);
  }

  async updateMedia(userId: string, merchantProfileId: string, mediaId: string, input: { title?: string; description?: string }): Promise<void> {
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (input.title !== undefined) { fields.push(`title = $${idx++}`); values.push(input.title); }
    if (input.description !== undefined) { fields.push(`description = $${idx++}`); values.push(input.description); }
    if (fields.length > 0) {
      values.push(mediaId, p.id);
      await pool.query(`UPDATE konektag.merchant_media SET ${fields.join(', ')} WHERE id = $${idx++} AND merchant_profile_id = $${idx}`, values);
    }
  }

  async suspendProfile(userId: string): Promise<MerchantProfile> {
    const p = await this.resolveProfile(userId);
    await pool.query(`UPDATE konektag.merchant_profiles SET status = 'Suspended' WHERE id = $1`, [p.id]);
    return loadFullProfile(p.id);
  }

  async reorderMedia(userId: string, orderDicts: { id: string; displayOrder: number }[]): Promise<void> {
    const p = await this.resolveProfile(userId);
    for (const { id, displayOrder } of orderDicts) {
      await pool.query(`UPDATE konektag.merchant_media SET display_order = $1 WHERE id = $2 AND merchant_profile_id = $3`,
        [displayOrder, id, p.id]);
    }
  }

  async saveExternalLinks(userId: string, links: Omit<MerchantExternalLink, 'id' | 'merchantProfileId' | 'createdAt' | 'updatedAt' | 'version'>[]): Promise<void> {
    const p = await this.resolveProfile(userId);
    for (const link of links) { try { new URL(link.url); } catch { throw new MerchantInvalidUrlError(link.url); } }
    await pool.query(`DELETE FROM konektag.merchant_external_links WHERE merchant_profile_id = $1`, [p.id]);
    for (let i = 0; i < links.length; i++) {
      await pool.query(`INSERT INTO konektag.merchant_external_links (merchant_profile_id, label, url, link_type, display_order) VALUES ($1,$2,$3,$4,$5)`,
        [p.id, links[i].label, links[i].url, links[i].linkType, i]);
    }
  }

  async getManagedProfile(userId: string, merchantProfileId: string): Promise<MerchantProfile> {
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    return loadFullProfile(p.id);
  }

  private async resolveManagedProfile(userId: string, profileId?: string): Promise<any> {
    if (!profileId) {
      const profile = await this.resolveProfile(userId);
      await this.requireOwnerOrManager(profile.id, userId);
      return profile;
    }
    await this.requireOwnerOrManager(profileId, userId);
    const { rows: [profile] } = await pool.query(
      `SELECT * FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [profileId],
    );
    if (!profile) throw new MerchantProfileNotFoundError(profileId);
    return profile;
  }

  async getOpeningHours(userId: string, activityCode?: ActivityCode | null, merchantProfileId?: string): Promise<MerchantOpeningHour[]> {
    const scope = ActivityCodeSchema.nullish().parse(activityCode) ?? null;
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    const { rows } = await pool.query(
      `SELECT * FROM konektag.merchant_opening_hours
       WHERE merchant_profile_id = $1 AND deleted_at IS NULL
         AND (activity_code IS NULL OR activity_code = $2) ORDER BY day_of_week`, [p.id, scope],
    );
    const specific = scope ? rows.filter(row => row.activity_code === scope) : [];
    const specificDays = new Set(specific.map(row => row.day_of_week));
    return mapRows(rows.filter(row => row.activity_code === scope ||
      (row.activity_code === null && !specificDays.has(row.day_of_week)))) as unknown as MerchantOpeningHour[];
  }

  async saveOpeningHours(userId: string, hours: Omit<MerchantOpeningHour, 'id' | 'merchantProfileId'>[], activityCode?: ActivityCode | null, merchantProfileId?: string): Promise<void> {
    const scope = ActivityCodeSchema.nullish().parse(activityCode) ?? null;
    if (new Set(hours.map(hour => hour.dayOfWeek)).size !== hours.length) throw new Error('DUPLICATE_OPENING_HOURS_DAY');
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize replacements, including the first save of an empty scope.
      await client.query(`SELECT id FROM konektag.merchant_profiles WHERE id = $1 FOR UPDATE`, [p.id]);
      await client.query(`DELETE FROM konektag.merchant_opening_hours WHERE merchant_profile_id = $1 AND activity_code IS NOT DISTINCT FROM $2`, [p.id, scope]);
      for (const h of hours) {
        await client.query(
          `INSERT INTO konektag.merchant_opening_hours (merchant_profile_id, activity_code, day_of_week, open_time, close_time, is_closed, break_start_time, break_end_time, open_time_2, close_time_2)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [p.id, scope, h.dayOfWeek, h.openTime ?? null, h.closeTime ?? null, h.isClosed,
           h.breakStartTime ?? null, h.breakEndTime ?? null, h.openTime2 ?? null, h.closeTime2 ?? null],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveRestaurantProfile(userId: string, input: z.input<typeof RestaurantSchema> & { merchantProfileId: string }): Promise<void> {
    const p = await this.resolveManagedProfile(userId, input.merchantProfileId);
    await upsertActivityProfile(pool, p.id, 'Restaurant', input);
  }

  async saveHotelProfile(userId: string, input: z.input<typeof HotelSchema> & { merchantProfileId: string }): Promise<void> {
    const p = await this.resolveManagedProfile(userId, input.merchantProfileId);
    await upsertActivityProfile(pool, p.id, 'Hotel', input);
  }

  async saveCommerceProfile(userId: string, input: z.input<typeof CommerceSchema> & { merchantProfileId: string }): Promise<void> {
    const p = await this.resolveManagedProfile(userId, input.merchantProfileId);
    await upsertActivityProfile(pool, p.id, 'Commerce', input);
  }

  async listProducts(userId: string): Promise<any[]> {
    const p=await this.resolveProfile(userId); await requireEntitlement(userId,p.id,'catalog.prepare');
    const {rows}=await pool.query(`SELECT * FROM konektag.merchant_products WHERE merchant_profile_id=$1 AND deleted_at IS NULL ORDER BY display_order,created_at,id`,[p.id]);
    return mapRows(rows);
  }

  async getProduct(userId:string,productId:string):Promise<any>{
    const p=await this.resolveProfile(userId); await requireEntitlement(userId,p.id,'catalog.prepare');
    const {rows:[row]}=await pool.query(`SELECT * FROM konektag.merchant_products WHERE merchant_profile_id=$1 AND id=$2 AND deleted_at IS NULL`,[p.id,productId]);
    if(!row)throw new Error('PRODUCT_NOT_FOUND'); return mapRow(row);
  }

  // Retain method signatures for callers, but no native product writes are allowed.
  async createProduct(_userId:string,_prod:any):Promise<any>{throw new Error(NATIVE_CATALOG_RETIRED);}
  async updateProduct(_userId:string,_productId:string,_patch:any):Promise<any>{throw new Error(NATIVE_CATALOG_RETIRED);}
  async deleteProduct(_userId:string,_productId:string):Promise<void>{throw new Error(NATIVE_CATALOG_RETIRED);}

  async addMember(
    merchantProfileId: string,
    userId: string,
    role: 'manager' | 'marketing' | 'accountant' | 'employee',
    createdBy: string,
  ): Promise<void> {
    const correlationId = getCorrelationId();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM konektag.merchant_profiles WHERE id = $1 FOR UPDATE', [merchantProfileId]);
      const decision = await requireEntitlement(createdBy, merchantProfileId, 'membership.manage', client);
      if (role === 'manager' && decision.subscriptionState === 'ACTIVE') {
        const { rows: [existing] } = await client.query(
          "SELECT id FROM konektag.merchant_memberships WHERE merchant_profile_id = $1 AND user_id = $2 AND status = 'active' AND role = 'manager'",
          [merchantProfileId, userId]);
        if (!existing) await requireEntitlement(createdBy, merchantProfileId, 'membership.manage', client, 1);
      }

      await client.query(
        `INSERT INTO konektag.merchant_memberships (merchant_profile_id, user_id, role, status, approved_at, created_by)
         VALUES ($1, $2, $3, 'active', now(), $4)
         ON CONFLICT (merchant_profile_id, user_id) DO UPDATE SET status = 'active', role = EXCLUDED.role, removed_at = NULL, approved_at = now()`,
         [merchantProfileId, userId, role, createdBy],
      );

      // Émettre l'événement MerchantMembershipAdded
      const { rows: [mm] } = await client.query(
        `SELECT id FROM konektag.merchant_memberships WHERE merchant_profile_id = $1 AND user_id = $2`,
        [merchantProfileId, userId],
      );
      if (mm) {
        await client.query(
          `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
           VALUES ($1, 'MerchantProfile', $2, 'MerchantMembershipAdded', 1, $3)`,
          [correlationId, merchantProfileId, JSON.stringify({
            membershipId: mm.id,
            merchantId: merchantProfileId,
            userId,
            role,
          })],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async removeMember(merchantProfileId: string, userId: string, keycloakId?: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Vérifier que le membre existe
      const { rows: [membership] } = await client.query(
        `SELECT id, role, is_primary FROM konektag.merchant_memberships
         WHERE merchant_profile_id = $1 AND user_id = $2 AND status = 'active'`,
        [merchantProfileId, userId],
      );
      if (!membership) throw new Error('Membre introuvable ou déjà retiré');

      // Empêcher le retrait du dernier owner primaire actif
      if (membership.role === 'owner' && membership.is_primary) {
        const { rows: [otherOwner] } = await client.query(
          `SELECT id FROM konektag.merchant_memberships
           WHERE merchant_profile_id = $1 AND role = 'owner' AND status = 'active' AND id != $2`,
          [merchantProfileId, membership.id],
        );
        if (!otherOwner) {
          throw new Error('Impossible de retirer le dernier propriétaire principal. Transférez d\'abord la propriété.');
        }
      }

      await client.query(
        `UPDATE konektag.merchant_memberships SET status = 'removed', removed_at = now() WHERE id = $1`,
        [membership.id],
      );

      // Si c'était le propriétaire principal et qu'il n'y a plus d'owner actif, vider user_id legacy
      if (membership.role === 'owner' && membership.is_primary) {
        await client.query(
          `UPDATE konektag.merchant_profiles SET user_id = NULL WHERE id = $1`,
          [merchantProfileId],
        );
      }

      const correlationId = getCorrelationId();
      await client.query(
        `INSERT INTO konektag.outbox_events
         (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
         VALUES ($1, 'MerchantProfile', $2, 'MerchantMembershipRemoved', 1, $3)`,
        [correlationId, merchantProfileId, JSON.stringify({ merchantId: merchantProfileId, userId, keycloakId })],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ═══ CERTIFICATION ═══

  private KYB_REQUIRED_DOC_TYPES: CertificationDocumentType[] = [
    'business_document', 'manager_identity', 'establishment_photo',
  ];

  private CERTIFICATION_REQUIRED_TX = 10;

  async getCertificationDossier(userId: string): Promise<CertificationDossier> {
    const p = await this.resolveProfile(userId);
    return this.loadCertificationDossier(p.id, p.certification_status, p.certification_submitted_at, p.certification_reviewed_at, p.certification_reviewed_by);
  }

  async getCertificationDossierByProfileId(profileId: string): Promise<CertificationDossier> {
    const { rows: [p] } = await pool.query(
      `SELECT id, certification_status, certification_submitted_at, certification_reviewed_at, certification_reviewed_by
       FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`,
      [profileId],
    );
    if (!p) throw new MerchantProfileNotFoundError(profileId);
    return this.loadCertificationDossier(p.id, p.certification_status, p.certification_submitted_at, p.certification_reviewed_at, p.certification_reviewed_by);
  }

  private async loadCertificationDossier(profileId: string, status: string, submittedAt?: string, reviewedAt?: string, reviewedBy?: string): Promise<CertificationDossier> {
    const { rows: docs } = await pool.query(
      `SELECT id, merchant_profile_id, document_type, title, file_url, file_key, mime_type, submitted_at, created_at
       FROM konektag.merchant_kyb_documents
       WHERE merchant_profile_id = $1 AND deleted_at IS NULL
       ORDER BY document_type, submitted_at DESC`,
      [profileId],
    );
    const receivedTx = await this.countReceivedTransactions(profileId);

    return {
      status: status as CertificationStatus,
      submittedAt: submittedAt ?? undefined,
      reviewedAt: reviewedAt ?? undefined,
      reviewedBy: reviewedBy ?? undefined,
      documents: docs.map((d: any) => ({
        id: d.id,
        merchantProfileId: d.merchant_profile_id,
        documentType: d.document_type as CertificationDocumentType,
        title: d.title,
        fileUrl: d.file_url,
        fileKey: d.file_key,
        mimeType: d.mime_type,
        submittedAt: d.submitted_at,
        createdAt: d.created_at,
      })),
      receivedTransactions: receivedTx,
      receivedTransactionsRequired: this.CERTIFICATION_REQUIRED_TX,
    };
  }

  async uploadKybDocument(userId: string, docType: CertificationDocumentType, file: FileInput, title?: string): Promise<CertificationDocument> {
    const p = await this.resolveProfile(userId);
    const { url, key } = await merchantMediaStorage.uploadMedia(p.id, {
      buffer: file.buffer,
      originalName: file.originalName,
      mimeType: file.mimeType,
    });

    const { rows: [doc] } = await pool.query(
      `INSERT INTO konektag.merchant_kyb_documents (merchant_profile_id, document_type, title, file_url, file_key, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [p.id, docType, title ?? null, url, key ?? null, file.mimeType],
    );

    return {
      id: doc.id,
      merchantProfileId: doc.merchant_profile_id,
      documentType: doc.document_type as CertificationDocumentType,
      title: doc.title,
      fileUrl: doc.file_url,
      fileKey: doc.file_key,
      mimeType: doc.mime_type,
      submittedAt: doc.submitted_at,
      createdAt: doc.created_at,
    };
  }

  async deleteKybDocument(userId: string, docId: string): Promise<void> {
    const p = await this.resolveProfile(userId);
    await pool.query(
      `UPDATE konektag.merchant_kyb_documents SET deleted_at = now() WHERE id = $1 AND merchant_profile_id = $2`,
      [docId, p.id],
    );
  }

  async submitKyb(userId: string): Promise<CertificationDossier> {
    const p = await this.resolveProfile(userId);
    const { rows: docs } = await pool.query(
      `SELECT document_type FROM konektag.merchant_kyb_documents WHERE merchant_profile_id = $1 AND deleted_at IS NULL`,
      [p.id],
    );
    const providedTypes = new Set(docs.map((d: any) => d.document_type));
    const missing = this.KYB_REQUIRED_DOC_TYPES.filter(t => !providedTypes.has(t));
    if (missing.length > 0) throw new MerchantCertificationIncompleteError(missing);

    await pool.query(
      `UPDATE konektag.merchant_profiles
       SET kyb_status = 'DOCUMENTS_SUBMITTED',
           kyb_submitted_at = now(),
           version = version + 1
       WHERE id = $1`,
      [p.id],
    );

    const correlationId = getCorrelationId();
    await pool.query(
      `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload) VALUES ($1,$2,$3,$4)`,
      [userId, correlationId, 'MERCHANT_KYB_SUBMITTED', { profileId: p.id, slug: p.slug }],
    );

    return this.loadCertificationDossier(p.id, p.certification_status, new Date().toISOString());
  }

  async countReceivedTransactions(profileId: string): Promise<number> {
    const { rows: [r] } = await pool.query(
      `SELECT konektag.count_merchant_received_transactions($1) AS cnt`,
      [profileId],
    );
    return parseInt(r.cnt, 10) || 0;
  }

  async getQrCode(userId: string, merchantProfileId?: string): Promise<{ qrCodeUrl: string; publicPageUrl: string }> {
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    return { qrCodeUrl: p.qr_code_url ?? '', publicPageUrl: p.public_page_url ?? '' };
  }

  async generatePermanentQrCode(userId: string, merchantProfileId?: string): Promise<{ qrCodeUrl: string; publicPageUrl: string }> {
    const p = await this.resolveManagedProfile(userId, merchantProfileId);
    const location = requireMerchantLocation(p);
    const { rows: [localeRow] } = await pool.query(`SELECT locale FROM konektag.users WHERE id = $1`, [userId]);
    const locale = localeRow?.locale ?? 'fr';
    // A stored URL from before the location invariant may lack its city segment.
    const publicPageUrl = p.public_page_url && !p.public_page_url.includes('//')
      ? p.public_page_url
      : marketplaceMerchantPath(locale, location.city, p.slug);
    const qrBuffer = await qrcodeService.generateQrCodeBuffer(`https://konektag.io${publicPageUrl}`);
    const { url: qrCodeUrl } = await merchantMediaStorage.uploadQrCode(p.id, qrBuffer);
    await pool.query(
      `UPDATE konektag.merchant_profiles SET qr_code_url = $1, public_page_url = $2, version = version + 1 WHERE id = $3`,
      [qrCodeUrl, publicPageUrl, p.id],
    );
    return { qrCodeUrl, publicPageUrl };
  }
}

export const merchantService = new MerchantService();

