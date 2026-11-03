import { merchantService } from '../../../../application/merchant-service.ts';
import { MerchantActivationRequiredError, MerchantCannotPublishError, MerchantProfileNotFoundError } from '../../../../domain/MerchantErrors.ts';
import { z } from 'zod';
import { RestaurantSchema, HotelSchema, CommerceSchema, upsertActivityProfile, ActivityCodeSchema, setActivityPublication } from '../../../../application/merchant-activity-profile.ts';
import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { cardBatchService } from '../../../../application/services/card-batch-service.ts';

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals, params }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const profileId = params.id as string;
  if (!profileId) return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });

  const { rows: [p] } = await pool.query(`SELECT * FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
  if (!p) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });

  const { rows: [resto] } = await pool.query(`SELECT * FROM konektag.restaurant_profiles WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [profileId]);
  const { rows: [hotel] } = await pool.query(`SELECT * FROM konektag.hotel_profiles WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [profileId]);
  const { rows: [commerce] } = await pool.query(`SELECT * FROM konektag.commerce_profiles WHERE merchant_profile_id = $1 AND deleted_at IS NULL`, [profileId]);
  const { rows: [u] } = await pool.query(`SELECT id, username FROM konektag.users WHERE id = $1`, [p.user_id]);

  return new Response(JSON.stringify({
    ...p,
    username: u?.username || null,
    restaurantProfile: resto || null,
    hotelProfile: hotel || null,
    commerceProfile: commerce || null,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const PUT: RouteHandler = async ({ locals, request, params }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const profileId = params.id as string;
  if (!profileId) return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });

  const body = await request.json();
  const { userId, businessName, city, country, shortDescription, longDescription, phone, email, websiteUrl, address, latitude, longitude } = body;

  const activities = z.object({
    restaurantProfile: RestaurantSchema.optional(),
    hotelProfile: HotelSchema.optional(),
    commerceProfile: CommerceSchema.optional(),
  }).safeParse(body);
  if (!activities.success) return new Response(JSON.stringify({ errors: activities.error.flatten().fieldErrors }), { status: 422 });
  const { rows: [profile] } = await pool.query(`SELECT id, user_id FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
  if (!profile) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });

  // Reassign the primary owner consistently across the canonical membership model
  // and the legacy merchant_profiles.user_id compatibility column.
  if (userId !== undefined && userId !== profile.user_id) {
    const { rows: [targetUser] } = await pool.query(
      `SELECT id FROM konektag.users WHERE id = $1 AND deleted_at IS NULL AND banned_at IS NULL`,
      [userId],
    );
    if (!targetUser) return new Response(JSON.stringify({ error: 'USER_NOT_FOUND' }), { status: 404 });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE konektag.merchant_memberships
         SET is_primary = false, status = CASE WHEN role = 'owner' THEN 'removed' ELSE status END,
             removed_at = CASE WHEN role = 'owner' THEN now() ELSE removed_at END
         WHERE merchant_profile_id = $1 AND role = 'owner' AND status = 'active' AND user_id <> $2`,
        [profileId, userId],
      );
      await client.query(
        `INSERT INTO konektag.merchant_memberships
           (merchant_profile_id, user_id, role, status, is_primary, approved_at, created_by)
         VALUES ($1, $2, 'owner', 'active', true, now(), $3)
         ON CONFLICT (merchant_profile_id, user_id) DO UPDATE
           SET role = 'owner', status = 'active', is_primary = true,
               removed_at = NULL, approved_at = now(), updated_at = now()`,
        [profileId, userId, String(admin.id)],
      );
      await client.query(
        `UPDATE konektag.merchant_profiles SET user_id = $1, version = version + 1 WHERE id = $2 AND deleted_at IS NULL`,
        [userId, profileId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[admin/merchants] owner reassignment failed', err);
      return new Response(JSON.stringify({
        error: 'OWNER_REASSIGNMENT_FAILED',
        message: err instanceof Error ? err.message : 'Merchant owner reassignment failed',
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.release();
    }
  }

  // Update main profile
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const settable: [string, string | number | undefined][] = [
    ['business_name', businessName],
    ['short_description', shortDescription],
    ['long_description', longDescription],
    ['address', address],
    ['city', city],
    ['country', country],
    ['phone', phone],
    ['email', email],
    ['website_url', websiteUrl],
    ['latitude', latitude],
    ['longitude', longitude],
  ];

  for (const [col, val] of settable) {
    if (val !== undefined) { fields.push(`${col} = $${idx++}`); values.push(val || null); }
  }

  if (fields.length > 0) {
    values.push(profileId);
    await pool.query(
      `UPDATE konektag.merchant_profiles SET ${fields.join(', ')}, version = version + 1 WHERE id = $${idx} AND deleted_at IS NULL`,
      values,
    );
  }

  // Each explicit N3 payload activates or updates only that activity.
  for (const [key, code] of [['restaurantProfile', 'Restaurant'], ['hotelProfile', 'Hotel'], ['commerceProfile', 'Commerce']] as const) {
    if (activities.data[key] !== undefined) {
      await upsertActivityProfile(pool, profileId, code, activities.data[key]);
    }
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: RouteHandler = async ({ locals, request, params }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const profileId = params.id as string;
  if (!profileId) return new Response(JSON.stringify({ error: 'MISSING_ID' }), { status: 400 });

  const body = await request.json();
  const action = body.action as string;

  if (!['publish', 'unpublish', 'suspend', 'delete', 'feature', 'unfeature', 'enable_agent', 'disable_agent'].includes(action)) {
    return new Response(JSON.stringify({ error: 'INVALID_ACTION' }), { status: 400 });
  }

  try {
    switch (action) {
      case 'publish':
      case 'unpublish': {
        const code = ActivityCodeSchema.safeParse(body.activityCode);
        if (!code.success) return new Response(JSON.stringify({ error: 'INVALID_ACTIVITY_CODE' }), { status: 422 });
        const { rows: [profile] } = await pool.query(`SELECT * FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
        if (!profile) throw new MerchantProfileNotFoundError(profileId);
        if(action==='publish')await merchantService.publishProfileAsAdmin(admin.id,code.data,profileId);
        else await setActivityPublication(pool, profile, code.data, false);
        break;
      }
      case 'suspend':
        await pool.query(`UPDATE konektag.merchant_profiles SET status = 'Suspended', version = version + 1 WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
        break;
      case 'delete':
        await pool.query(`UPDATE konektag.merchant_profiles SET deleted_at = now(), version = version + 1 WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
        break;
      case 'feature':
        await pool.query(`UPDATE konektag.merchant_profiles SET featured = true, featured_at = now(), version = version + 1 WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
        break;
      case 'unfeature':
        await pool.query(`UPDATE konektag.merchant_profiles SET featured = false, featured_at = NULL, version = version + 1 WHERE id = $1 AND deleted_at IS NULL`, [profileId]);
        break;
      case 'enable_agent':
        await cardBatchService.toggleAgentCapability(profileId, true, admin.id);
        break;
      case 'disable_agent':
        await cardBatchService.toggleAgentCapability(profileId, false, admin.id);
        break;
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: any) {
    if (err instanceof MerchantActivationRequiredError) return new Response(JSON.stringify({ error: err.code, message: err.message }), { status: 403 });
    if (err instanceof MerchantCannotPublishError) return new Response(JSON.stringify({ error: err.code, message: err.message }), { status: 422 });
    if (err instanceof MerchantProfileNotFoundError) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    console.error('[admin/merchants]', err);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
