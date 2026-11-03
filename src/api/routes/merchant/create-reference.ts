import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import pool from '../../../infrastructure/database/pool.ts';
import {publicMarketplaceCtes} from '../../../application/services/public-marketplace-sql.ts';
import { marketplaceSlug } from '../../../application/shared/marketplace/slug.ts';
import { getCorrelationId } from '../../../infrastructure/correlation-id.ts';

const Schema=z.object({
  businessName:z.string().trim().min(2).max(200),
  activity:z.enum(['Restaurant','Hotel','Commerce']),
  city:z.string().trim().min(1).max(100),
  country:z.string().trim().min(1).max(100),
  address:z.string().trim().max(300).optional(),
  phone:z.string().trim().max(30).optional(),
  email:z.string().trim().email().max(200).optional().or(z.literal('')),
});

const normalizedSql=(column:string)=>`lower(regexp_replace(trim(${column}), '\\s+', ' ', 'g'))`;

export const POST:RouteHandler=async({request,locals})=>{
  const user=locals.user;
  if(!user)return new Response(JSON.stringify({error:'AUTHENTICATION_REQUIRED'}),{status:401,headers:{'Content-Type':'application/json'}});
  let body:unknown;try{body=await request.json()}catch{return new Response(JSON.stringify({error:'INVALID_JSON'}),{status:400})}
  const parsed=Schema.safeParse(body);
  if(!parsed.success)return new Response(JSON.stringify({error:'INVALID_INPUT',fields:parsed.error.flatten().fieldErrors}),{status:422,headers:{'Content-Type':'application/json'}});
  const input=parsed.data,client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Serialize same city/name creation attempts to prevent concurrent duplicates.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext(lower($1)||'|'||lower($2)))`,[input.city,input.businessName]);
    const {rows:[existing]}=await client.query(
      `SELECT mp.id,mp.business_name,mp.slug,mp.city,mp.address,
        (mp.user_id IS NOT NULL OR EXISTS(
          SELECT 1 FROM konektag.merchant_memberships mm
          WHERE mm.merchant_profile_id=mp.id AND mm.role='owner' AND mm.status='active' AND mm.removed_at IS NULL
        )) AS associated
       FROM konektag.merchant_profiles mp
       WHERE mp.deleted_at IS NULL
         AND ${normalizedSql('mp.business_name')}=${normalizedSql('$1')}
         AND ${normalizedSql('mp.city')}=${normalizedSql('$2')}
       ORDER BY mp.created_at LIMIT 1 FOR UPDATE`,
      [input.businessName,input.city],
    );
    if(existing){
      const {rows:[publicRow]}=await client.query(`${publicMarketplaceCtes} SELECT snapshot->'merchant' AS merchant FROM public_n2 WHERE merchant_profile_id=$1`,[existing.id]);
      await client.query('ROLLBACK');
      if(!publicRow)return Response.json({error:'ESTABLISHMENT_UNAVAILABLE'},{status:409});
      const published=publicRow.merchant;
      return new Response(JSON.stringify({status:'existing',merchant:{businessName:published.businessName,slug:published.slug,city:published.city,address:published.address,associated:!!existing.associated}}),{status:409,headers:{'Content-Type':'application/json'}});
    }
    const base=marketplaceSlug(input.businessName)||'commerce';
    const slug=`${base}-${randomUUID().slice(0,8)}`;
    const {rows:[merchant]}=await client.query(
      `INSERT INTO konektag.merchant_profiles
       (business_name,slug,status,city,country,address,phone,email,source,referenced_at)
       VALUES($1,$2,'Referenced',$3,$4,$5,$6,$7,'marketplace_user',now())
       RETURNING id,business_name,slug,city`,
      [input.businessName,slug,input.city,input.country,input.address||null,input.phone||null,input.email||null],
    );
    if(input.activity==='Restaurant')await client.query(`INSERT INTO konektag.restaurant_profiles(merchant_profile_id,status) VALUES($1,'Referenced') ON CONFLICT (merchant_profile_id) DO UPDATE SET status='Referenced'`,[merchant.id]);
    if(input.activity==='Hotel')await client.query(`INSERT INTO konektag.hotel_profiles(merchant_profile_id,status) VALUES($1,'Referenced') ON CONFLICT (merchant_profile_id) DO UPDATE SET status='Referenced'`,[merchant.id]);
    if(input.activity==='Commerce')await client.query(`INSERT INTO konektag.commerce_profiles(merchant_profile_id,status) VALUES($1,'Referenced') ON CONFLICT (merchant_profile_id) DO UPDATE SET status='Referenced'`,[merchant.id]);
    await client.query('SELECT konektag.snapshot_new_reference($1,$2)',[merchant.id,input.activity]);
    await client.query(`INSERT INTO konektag.merchant_claims(merchant_profile_id,user_id,status) VALUES($1,$2,'pending')`,[merchant.id,user.id]);
    const correlationId=getCorrelationId();
    await client.query(`INSERT INTO konektag.audit_logs(user_id,correlation_id,event_type,payload) VALUES($1,$2,'MERCHANT_CLAIM_REQUESTED',$3)`,[user.id,correlationId,{profileId:merchant.id,slug:merchant.slug}]);
    await client.query('COMMIT');
    return new Response(JSON.stringify({status:'pending',merchant:{businessName:merchant.business_name,slug:merchant.slug,city:merchant.city}}),{status:201,headers:{'Content-Type':'application/json'}});
  }catch(error){await client.query('ROLLBACK');console.error('[merchant/create-reference]',error);return new Response(JSON.stringify({error:'SERVER_ERROR'}),{status:500,headers:{'Content-Type':'application/json'}})}
  finally{client.release()}
};