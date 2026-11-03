import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';
import { merchantService } from '../../../../../application/merchant-service.ts';

const ADMIN_CHECK = `SELECT role FROM konektag.users WHERE id = $1`;

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(ADMIN_CHECK, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals, request }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const url = new URL(request.url);
  const profileId = url.searchParams.get('profileId');
  if (!profileId) return new Response(JSON.stringify({ error: 'MISSING_profileId' }), { status: 400 });

  try {
    const dossier = await merchantService.getCertificationDossierByProfileId(profileId);
    return new Response(JSON.stringify(dossier), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[admin/certification GET]', error);
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 422 });
  }
};

export const POST: RouteHandler = async ({ locals }) => {
  const admin = await adminGuard(locals);
  if (!admin) return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
  return Response.json({
    error: 'CERTIFICATION_AUTOMATIC',
    message: 'La certification est automatique après 10 transactions terminées.',
  }, { status: 409 });
};
