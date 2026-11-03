import { MerchantCannotPublishError, MerchantProfileNotFoundError } from '../domain/MerchantErrors.ts';
import { z } from 'zod';
import type { ActivityCode } from '../domain/MerchantProfile.ts';

export const ActivityCodeSchema = z.enum(['Restaurant', 'Hotel', 'Commerce']);
export const activityTables: Record<ActivityCode, string> = {
  Restaurant: 'restaurant_profiles', Hotel: 'hotel_profiles', Commerce: 'commerce_profiles',
};

const overrides = {
  shortDescription: z.string().max(500).nullish(),
  longDescription: z.string().max(5000).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().max(200).nullish(),
};

export const RestaurantSchema = z.object({
  ...overrides,
  hasDineIn: z.boolean().optional(),
  priceRange: z.enum(['Low', 'Medium', 'High', 'Premium']).optional(),
  cuisineTypes: z.array(z.string()).optional(),
  offerType: z.enum(['AlaCarte', 'DailyMenu', 'SingleDish', 'Other']).nullable().optional(),
  menuMedium: z.enum(['Konektag', 'Pdf', 'Image', 'External', 'Board', 'None']).nullable().optional(),
  menuExternalUrl: z.string().url().max(500).nullable().optional(),
  menuMediaId: z.string().uuid().nullable().optional(),
  specialties: z.string().max(2000).nullable().optional(),
  averageMealPrice: z.number().positive().nullable().optional(),
  hasDelivery: z.boolean().optional(),
  hasTakeAway: z.boolean().optional(),
  hasReservation: z.boolean().optional(),
});

export const HotelSchema = z.object({
  ...overrides,
  hasDelivery: z.boolean().optional(),
  hasTakeout: z.boolean().optional(),
  hasDineIn: z.boolean().optional(),
  priceRange: z.enum(['Low', 'Medium', 'High', 'Premium']).optional(),
  stars: z.number().min(1).max(5).nullable().optional(),
  roomPriceMin: z.number().positive().nullable().optional(),
  roomPriceMax: z.number().positive().nullable().optional(),
  amenities: z.array(z.string()).optional(),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  hasOnlineBooking: z.boolean().optional(),
});

export const CommerceSchema = z.object({
  ...overrides,
  hasDelivery: z.boolean().optional(),
  hasTakeout: z.boolean().optional(),
  mainActivity: z.enum(['Alimentation', 'Mode', 'Beauté', 'Électronique', 'Services', 'Artisanat', 'Santé', 'Autre']).optional(),
  hasDineIn: z.boolean().optional(),
  priceRange: z.enum(['Low', 'Medium', 'High', 'Premium']).optional(),
  productsServices: z.string().max(2000).nullable().optional(),
  hasCatalog: z.boolean().optional(),
});

export const activitySchemas = { Restaurant: RestaurantSchema, Hotel: HotelSchema, Commerce: CommerceSchema };

// Callers must authorize the target establishment before writing.
export async function upsertActivityProfile(
  db: { query: (sql: string, values: any[]) => Promise<any> },
  profileId: string,
  activityCode: ActivityCode,
  input: unknown,
): Promise<void> {
  const code = ActivityCodeSchema.parse(activityCode);
  const data = activitySchemas[code].parse(input);
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const columns = entries.map(([key]) => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`));
  const values = entries.map(([key, value]) =>
    ['cuisineTypes', 'amenities'].includes(key) ? JSON.stringify(value) : value);
  await db.query(
    `INSERT INTO konektag.${activityTables[code]} (merchant_profile_id${columns.map(c => `, ${c}`).join('')})
     VALUES ($1${values.map((_, i) => `,$${i + 2}`).join('')})
     ON CONFLICT (merchant_profile_id) DO UPDATE SET
       ${columns.map(c => `${c} = EXCLUDED.${c}, `).join('')}deleted_at = NULL, updated_at = now()`,
    [profileId, ...values],
  );
}

// The merchant or admin caller must authorize the parent before changing publication.
export async function setActivityPublication(
  db: { query: (sql: string, values: any[]) => Promise<any> },
  parent: { id: string; status: string; business_name?: string; city?: string; short_description?: string; phone?: string },
  activityCode: ActivityCode,
  published: boolean,
): Promise<void> {
  const code = ActivityCodeSchema.parse(activityCode);
  if (published) {
    if (parent.status === 'Suspended') throw new MerchantCannotPublishError('Establishment is suspended');
    const { rows: [activity] } = await db.query(
      `SELECT * FROM konektag.${activityTables[code]} WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [parent.id],
    );
    if (!activity) throw new MerchantProfileNotFoundError(`${parent.id}/${code}`);
    const resolved = {
      business_name: parent.business_name, city: parent.city,
      short_description: activity.short_description ?? parent.short_description,
      phone: activity.phone ?? parent.phone,
    };
    const missing = Object.entries(resolved).filter(([, value]) => !value).map(([field]) => field);
    if (missing.length) throw new MerchantCannotPublishError(`Missing required fields: ${missing.join(', ')}`);
  }
  const { rows } = await db.query(
    `UPDATE konektag.${activityTables[code]} SET status = $2, updated_at = now()
     WHERE merchant_profile_id = $1 AND deleted_at IS NULL RETURNING merchant_profile_id`,
    [parent.id, published ? 'Published' : 'Draft'],
  );
  if (!rows[0]) throw new MerchantProfileNotFoundError(`${parent.id}/${code}`);
}
