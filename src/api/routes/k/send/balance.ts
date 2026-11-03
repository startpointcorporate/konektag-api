import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { kPointsBalance } from '../../../../application/services/k-points-service.ts';
export const GET:RouteHandler=async({locals})=>{const u=locals.user;if(!u)return new Response(null,{status:401});const {rows:[party]}=await pool.query<{id:string}>(`SELECT id FROM konektag.parties WHERE keycloak_id=$1 AND is_active=true`,[u.keycloak_id]);if(!party)return new Response(JSON.stringify({availableK:0}),{headers:{'Content-Type':'application/json'}});const b=await kPointsBalance(party.id);return new Response(JSON.stringify({availableK:b.available}),{headers:{'Content-Type':'application/json'}});};
