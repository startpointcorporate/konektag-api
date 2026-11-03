import type { RequestContext } from '../../../http';
import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import pool from '../../../../infrastructure/database/pool.ts';

const Body=z.object({
  categoryId:z.string().uuid(),
  code:z.string().min(1).max(100),
  nameI18n:z.record(z.string(),z.string()),
  sortOrder:z.number().int().optional(),
  isActive:z.boolean().optional(),
}).strict();
const json=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{'Content-Type':'application/json'}});
async function isAdmin(locals: RequestContext['locals']): Promise<boolean> {
  if (!locals.user) return false;
  const { rows: [databaseUser] } = await pool.query('SELECT role FROM konektag.users WHERE id = $1', [locals.user.id]);
  return databaseUser?.role === 'admin';
}

export const GET:RouteHandler=async({locals,url})=>{
  if(!(await isAdmin(locals)))return json({error:'Unauthorized'},401);
  const categoryId=url.searchParams.get('categoryId');
  const params:unknown[]=[]; const where=['s.deleted_at IS NULL'];
  if(categoryId){const parsed=z.string().uuid().safeParse(categoryId);if(!parsed.success)return json({error:'INVALID_CATEGORY_ID'},422);params.push(parsed.data);where.push(`s.category_id=${params.length}`);}
  const {rows}=await pool.query(
    `SELECT s.*,c.activity_code,c.code AS category_code
       FROM konektag.offer_subcategories s
       JOIN konektag.offer_categories c ON c.id=s.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.activity_code,c.sort_order,s.sort_order,s.code`,params);
  return json({subcategories:rows});
};

export const POST:RouteHandler=async({locals,request})=>{
  if(!(await isAdmin(locals)))return json({error:'Unauthorized'},401);
  let raw:unknown;try{raw=await request.json();}catch{return json({error:'INVALID_JSON'},400);}
  const parsed=Body.safeParse(raw);if(!parsed.success)return json({errors:parsed.error.flatten().fieldErrors},422);
  const b=parsed.data;
  const cat=await pool.query('SELECT id FROM konektag.offer_categories WHERE id=$1 AND deleted_at IS NULL AND is_active=true',[b.categoryId]);
  if(!cat.rowCount)return json({error:'CATEGORY_NOT_FOUND'},404);
  try{
    const {rows:[row]}=await pool.query(
      `INSERT INTO konektag.offer_subcategories(category_id,code,name_i18n,sort_order,is_active)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [b.categoryId,b.code,JSON.stringify(b.nameI18n),b.sortOrder??0,b.isActive??true]);
    return json({subcategory:row},201);
  }catch(e:any){if(e?.code==='23505')return json({error:'SUBCATEGORY_CODE_EXISTS'},409);console.error('[admin/offer-subcategories]',e);return json({error:'SERVER_ERROR'},500);}
};
