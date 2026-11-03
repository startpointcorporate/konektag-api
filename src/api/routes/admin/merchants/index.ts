import { merchantService } from '../../../../application/merchant-service.ts';
import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { hasMerchantLocation } from '../../../../domain/MerchantLocation.ts';

const ADMIN_CHECK = `SELECT role FROM konektag.users WHERE id = $1`;

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(ADMIN_CHECK, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals, request }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const search = url.searchParams.get('q') || '';

  let conditions = 'mp.deleted_at IS NULL';
  const params: unknown[] = [];
  let idx = 1;

  if (status && ['Draft', 'Published', 'Suspended', 'Referenced'].includes(status)) {
    conditions += ` AND mp.status = $${idx++}`;
    params.push(status);
  }
  if (search) {
    conditions += ` AND mp.business_name ILIKE $${idx}`;
    params.push(`%${search}%`);
    idx++;
  }

  const { rows: merchants } = await pool.query(
    `SELECT mp.id, mp.business_name, mp.slug, mp.city, mp.country, mp.status, mp.certification_status, mp.kyb_status, mp.kyb_submitted_at, mp.created_at, mp.updated_at,
            mp.featured, mp.featured_at, mp.user_id, mp.source, mp.rating, u.username,
            ARRAY_REMOVE(ARRAY[
              CASE WHEN rp.merchant_profile_id IS NOT NULL THEN 'Restaurant' END,
              CASE WHEN hp.merchant_profile_id IS NOT NULL THEN 'Hotel' END,
              CASE WHEN cp.merchant_profile_id IS NOT NULL THEN 'Commerce' END
            ], NULL) AS activity_codes,
            EXISTS (SELECT 1 FROM konektag.merchant_pro_subscriptions s WHERE s.merchant_profile_id=mp.id
              AND s.status='ACTIVE' AND s.subscription_start<=CURRENT_DATE
              AND (s.subscription_end IS NULL OR s.subscription_end>CURRENT_DATE)) AS has_pro_subscription
     FROM konektag.merchant_profiles mp
     LEFT JOIN konektag.users u ON u.id = mp.user_id
     LEFT JOIN konektag.restaurant_profiles rp
       ON rp.merchant_profile_id = mp.id AND rp.deleted_at IS NULL
     LEFT JOIN konektag.hotel_profiles hp
       ON hp.merchant_profile_id = mp.id AND hp.deleted_at IS NULL
     LEFT JOIN konektag.commerce_profiles cp
       ON cp.merchant_profile_id = mp.id AND cp.deleted_at IS NULL
     WHERE ${conditions}
     ORDER BY mp.updated_at DESC`,
    params,
  );

  return new Response(JSON.stringify(merchants), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: RouteHandler = async ({ locals, request }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const body = await request.json();
  const { userId, businessName, city, country, shortDescription, longDescription, phone, email, websiteUrl, address } = body;

  if (!userId || !businessName || !hasMerchantLocation({ city, country })) {
    return new Response(JSON.stringify({ error: 'MISSING_FIELDS', required: ['userId', 'businessName', 'country', 'city'] }), { status: 400 });
  }

  // Verify user exists
  const { rows: [targetUser] } = await pool.query(`SELECT id FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!targetUser) return new Response(JSON.stringify({ error: 'USER_NOT_FOUND' }), { status: 404 });

  // Check no existing profile for this user
  const { rows: [dup] } = await pool.query(`SELECT id FROM konektag.merchant_profiles WHERE user_id = $1 AND deleted_at IS NULL`, [userId]);
  if (dup) return new Response(JSON.stringify({ error: 'MERCHANT_ALREADY_EXISTS' }), { status: 409 });

  const p = await merchantService.createProfile(userId, {
    businessName, city, country, shortDescription, longDescription, phone, email, websiteUrl, address,
  });

  return new Response(JSON.stringify({ success: true, id: p.id, slug: p.slug }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};
