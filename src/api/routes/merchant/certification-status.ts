import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

export const GET: RouteHandler = async ({ request }) => {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) {
    return new Response(JSON.stringify({ certified: false }), { status: 200 });
  }

  try {
    const { rows: [p] } = await pool.query(
      `SELECT certification_status, certification_submitted_at
       FROM konektag.merchant_profiles
       WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    );

    if (!p) return new Response(JSON.stringify({ certified: false }), { status: 200 });

    const certified = p.certification_status === 'VALIDATED';

    return new Response(JSON.stringify({
      certified,
      certificationStatus: p.certification_status,
      certifiedSince: certified ? p.certification_submitted_at : null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[merchant/certification-status]', err);
    return new Response(JSON.stringify({ certified: false }), { status: 200 });
  }
};
