import pool from '../../infrastructure/database/pool.ts';

type AnalyticsAccess = { profileId: string; response?: never } | { profileId?: never; response: Response };

function refuse(error: string, status: number): AnalyticsAccess {
  return { response: new Response(JSON.stringify({ error }), {
    status, headers: { 'Content-Type': 'application/json' },
  }) };
}

/** Resolve only authorization metadata; never load commerce content before the guard. */
export async function resolveAnalyticsAccess(actorId: string, slug: string | null, requestedProfileId?: string | null): Promise<AnalyticsAccess> {
  let profileId: string;
  if (requestedProfileId) {
    const { rows: [profile] } = await pool.query('SELECT id FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL', [requestedProfileId]);
    if (!profile) return refuse('MERCHANT_NOT_FOUND', 404);
    profileId = profile.id;
  } else if (slug !== null) {
    const { rows: [profile] } = await pool.query(
      'SELECT id FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL', [slug],
    );
    if (!profile) return refuse('MERCHANT_NOT_FOUND', 404);
    profileId = profile.id;
  } else {
    const { rows } = await pool.query(
      `SELECT mp.id, mm.is_primary
       FROM konektag.merchant_profiles mp
       JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id
       WHERE mm.user_id = $1 AND mm.status = 'active' AND mm.removed_at IS NULL
         AND mm.role IN ('owner', 'manager') AND mp.deleted_at IS NULL`, [actorId],
    );
    if (!rows.length) return refuse('MERCHANT_NOT_FOUND', 404);
    // Preserve the existing primary-membership preference, but never choose an
    // arbitrary commerce when multiple eligible memberships have equal priority.
    const primary = rows.filter(row => row.is_primary === true);
    const candidates = primary.length ? primary : rows;
    if (candidates.length !== 1) return refuse('MERCHANT_SLUG_REQUIRED', 400);
    profileId = candidates[0].id;
  }
  // Analytics requires an active membership, including for historical owners.
  // The shared profile guard deliberately supports legacy ownership elsewhere.
  const { rows: authorized } = await pool.query(
    `SELECT 1 FROM konektag.merchant_memberships mm
     JOIN konektag.merchant_profiles mp ON mp.id = mm.merchant_profile_id
     WHERE mp.id = $1 AND mm.user_id = $2 AND mp.deleted_at IS NULL
       AND mm.status = 'active' AND mm.removed_at IS NULL
       AND mm.role IN ('owner', 'manager') LIMIT 1`, [profileId, actorId]);
  if (!authorized.length) return refuse('MEMBERSHIP_DENIED', 403);
  return { profileId };
}
