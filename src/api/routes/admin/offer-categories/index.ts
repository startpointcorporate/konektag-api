import type { RequestContext } from '../../../http';
import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import pool from '../../../../infrastructure/database/pool.ts';

const Activity = z.enum(['Restaurant', 'Hotel', 'Commerce']);
const Body = z.object({
  code: z.string().min(1).max(100),
  activityCode: Activity,
  nameI18n: z.record(z.string(), z.string()),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
}).strict();
const json=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{'Content-Type':'application/json'}});
async function isAdmin(locals: RequestContext['locals']): Promise<boolean> {
  if (!locals.user) return false;
  const { rows: [databaseUser] } = await pool.query('SELECT role FROM konektag.users WHERE id = $1', [locals.user.id]);
  return databaseUser?.role === 'admin';
}

export const GET: RouteHandler = async ({ locals, url }) => {
  if (!(await isAdmin(locals))) return json({ error: 'Unauthorized' }, 401);
  const activityCode = url.searchParams.get('activityCode');
  if (activityCode && !Activity.safeParse(activityCode).success) return json({ error: 'INVALID_ACTIVITY_CODE' }, 422);
  const params: unknown[] = [];
  const where = ['deleted_at IS NULL'];
  if (activityCode) { params.push(activityCode); where.push(`activity_code = $${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM konektag.offer_categories WHERE ${where.join(' AND ')} ORDER BY activity_code, sort_order, code`, params);
  return json({ categories: rows });
};

export const POST: RouteHandler = async ({ locals, request }) => {
  if (!(await isAdmin(locals))) return json({ error: 'Unauthorized' }, 401);
  let raw: unknown; try { raw = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  const parsed = Body.safeParse(raw); if (!parsed.success) return json({ errors: parsed.error.flatten().fieldErrors }, 422);
  const b = parsed.data;
  try {
    const { rows:[row] } = await pool.query(
      `INSERT INTO konektag.offer_categories(code,activity_code,name_i18n,sort_order,is_active)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [b.code,b.activityCode,JSON.stringify(b.nameI18n),b.sortOrder??0,b.isActive??true],
    );
    return json({ category: row }, 201);
  } catch (e:any) {
    if (e?.code === '23505') return json({ error: 'CATEGORY_CODE_EXISTS' }, 409);
    console.error('[admin/offer-categories]',e); return json({ error: 'SERVER_ERROR' }, 500);
  }
};
