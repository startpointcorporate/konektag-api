import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';

const json=(body:unknown,status=200)=>Response.json(body,{status});

async function dbUser(locals:any){
 const auth=locals.user; if(!auth?.keycloak_id) return null;
 const {rows:[u]}=await pool.query(
  `SELECT id,country,country_confirmed_at
   FROM konektag.users WHERE keycloak_id=$1 AND deleted_at IS NULL`,[auth.keycloak_id]);
 return u||null;
}

export const GET:RouteHandler=async({locals})=>{
 const u=await dbUser(locals); if(!u) return json({error:'UNAUTHORIZED'},401);
 const confirmed=u.country_confirmed_at?new Date(u.country_confirmed_at):null;
 const due=!u.country||!confirmed||confirmed.getTime()<=Date.now()-30*24*60*60*1000;
 return json({country:u.country||null,countryConfirmedAt:confirmed?.toISOString()||null,due});
};

export const POST:RouteHandler=async({locals,request})=>{
 const u=await dbUser(locals); if(!u) return json({error:'UNAUTHORIZED'},401);
 const body=await request.json().catch(()=>({}));
 const country=String(body?.country||'').trim().toUpperCase();
 if(!/^[A-Z]{2}$/.test(country)) return json({error:'INVALID_COUNTRY'},400);
 const {rows:[supported]}=await pool.query(
  `SELECT country_code,base_currency FROM konektag.legal_entities
   WHERE country_code=$1 AND status='APPROVED' AND deleted_at IS NULL
     AND (valid_from IS NULL OR valid_from<=CURRENT_DATE)
     AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)
   ORDER BY valid_from DESC NULLS LAST LIMIT 1`,[country]);
 if(!supported) return json({error:'COUNTRY_NOT_SUPPORTED'},409);
 const {rows:[saved]}=await pool.query(
  `UPDATE konektag.users SET country=$1,country_confirmed_at=now(),updated_at=now()
   WHERE id=$2 AND deleted_at IS NULL
   RETURNING country,country_confirmed_at`,[country,u.id]);
 return json({country:saved.country,countryConfirmedAt:saved.country_confirmed_at,currency:supported.base_currency,due:false});
};
