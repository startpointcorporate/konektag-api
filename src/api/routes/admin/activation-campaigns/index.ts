import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';

const ISO_COUNTRY = /^[A-Z]{2}$/;

async function adminGuard(locals: any) {
  const user = locals.user;
  if (!user) return null;
  const { rows } = await pool.query<{ role: string }>(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  return rows[0]?.role === 'admin' ? user : null;
}

function countries(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = [...new Set(value.map(country => String(country).trim().toUpperCase()))];
  return normalized.every(country => ISO_COUNTRY.test(country)) ? normalized : null;
}

export const GET: RouteHandler = async ({ locals }) => {
  if (!await adminGuard(locals)) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const { rows } = await pool.query(
    `SELECT c.*, COUNT(DISTINCT ch.id)::int AS participants,
            COALESCE(SUM(ch.total_bonus_earned), 0)::bigint AS bonuses_credited
     FROM konektag.activation_campaigns c
     LEFT JOIN konektag.activation_challenges ch ON ch.campaign_id = c.id
     WHERE c.deleted_at IS NULL
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
  );
  return new Response(JSON.stringify({ campaigns: rows }), { headers: { 'Content-Type': 'application/json' } });
};

export const POST: RouteHandler = async ({ locals, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const body = await request.json();
  const eligibleCountries = countries(body.eligibleCountryCodes ?? []);
  const milestones = Array.isArray(body.milestones) ? body.milestones : [];
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  const maxBonusAmount = Number(body.maxBonusAmount);
  if (!body.internalName || !body.publicTitle || !Number.isSafeInteger(maxBonusAmount) || maxBonusAmount <= 0
    || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt
    || eligibleCountries === null || milestones.length === 0) {
    return new Response(JSON.stringify({ error: 'INVALID_CAMPAIGN' }), { status: 400 });
  }
  const milestoneBonus = milestones.reduce((sum: number, milestone: { bonusAmount: number }) => sum + Number(milestone.bonusAmount), 0);
  if (!Number.isSafeInteger(milestoneBonus) || milestoneBonus > maxBonusAmount) {
    return new Response(JSON.stringify({ error: 'INVALID_BONUS_TOTAL' }), { status: 400 });
  }
  for (const [index, milestone] of milestones.entries()) {
    if (!['Deposit', 'KSend', 'QrPaymentReceived', 'MerchantPayment'].includes(milestone.metricType)
      || !Number.isSafeInteger(Number(milestone.targetAmount)) || Number(milestone.targetAmount) <= 0
      || !Number.isSafeInteger(Number(milestone.bonusAmount)) || Number(milestone.bonusAmount) <= 0
      || !String(milestone.publicTitle || '').trim() || !String(milestone.ctaType || '').trim()
      || countries(milestone.eligibleCountryCodes ?? []) === null) {
      return new Response(JSON.stringify({ error: 'INVALID_MILESTONE', index }), { status: 400 });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: campaignRows } = await client.query<{ id: string }>(
      `INSERT INTO konektag.activation_campaigns
        (internal_name, public_title, public_description, baseline, starts_at, ends_at, time_zone,
         individual_duration_days, max_bonus_amount, eligible_country_codes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'Europe/Paris', $7, $8, $9, $10, $10)
       RETURNING id`,
      [body.internalName.trim(), body.publicTitle.trim(), String(body.publicDescription ?? ''),
       String(body.baseline ?? ''), startsAt, endsAt, Number(body.individualDurationDays ?? 90),
       maxBonusAmount, eligibleCountries, admin.id],
    );
    const campaign = campaignRows[0];
    for (const [index, milestone] of milestones.entries()) {
      await client.query(
        `INSERT INTO konektag.activation_milestones
          (campaign_id, metric_type, target_amount, bonus_amount, requires_verified_account, sort_order,
           public_title, public_description, cta_type, eligible_country_codes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [campaign.id, milestone.metricType, Number(milestone.targetAmount), Number(milestone.bonusAmount),
         Boolean(milestone.requiresVerifiedAccount), index + 1, milestone.publicTitle.trim(),
         String(milestone.publicDescription ?? ''), milestone.ctaType.trim(), countries(milestone.eligibleCountryCodes ?? [])],
      );
    }
    const payload = { campaignId: campaign.id, milestoneCount: milestones.length };
    await client.query(
      `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
       VALUES ($1, 'ACTIVATION_CAMPAIGN_CREATE', 'activation_campaign', $2, $3, $4)`,
      [admin.id, campaign.id, 'Campaign created', JSON.stringify(payload)],
    );
    await client.query(
      `INSERT INTO konektag.activation_campaign_audit (campaign_id, actor_id, action, payload)
       VALUES ($1, $2, 'created', $3)`, [campaign.id, admin.id, JSON.stringify(payload)],
    );
    await client.query('COMMIT');
    return new Response(JSON.stringify({ id: campaign.id }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error.code === '23505') return new Response(JSON.stringify({ error: 'CAMPAIGN_ALREADY_EXISTS' }), { status: 409 });
    throw error;
  } finally {
    client.release();
  }
};
