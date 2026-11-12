import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { exchangeRateService } from '../../../application/services/exchange-rate-service.ts';
import { currencyForCountry } from '../../../application/services/operation-currency-service.ts';

export const GET:RouteHandler=async({locals})=>{
 const user=locals.user;if(!user)return Response.json({error:'UNAUTHORIZED'},{status:401});
 const {rows:[row]}=await pool.query(`SELECT up.preferred_currency,u.country FROM konektag.users u
  LEFT JOIN konektag.user_preferences up ON up.user_id=u.id AND up.deleted_at IS NULL WHERE u.id=$1`,[user.id]);
 const defaultCurrency=currencyForCountry(row?.country);
 return Response.json({currency:row?.preferred_currency||defaultCurrency,defaultCurrency,country:row?.country||null});
};

export const PUT:RouteHandler=async({request,locals})=>{
 const user=locals.user;if(!user)return Response.json({error:'UNAUTHORIZED'},{status:401});
 const body=await request.json().catch(()=>null) as {currency?:unknown}|null;
 const currency=typeof body?.currency==='string'?body.currency.trim().toUpperCase():'';
 if(!exchangeRateService.isSupported(currency))return Response.json({error:'UNSUPPORTED_CURRENCY'},{status:400});
 await pool.query(`INSERT INTO konektag.user_preferences(user_id,preferred_currency) VALUES($1,$2)
  ON CONFLICT(user_id) DO UPDATE SET preferred_currency=EXCLUDED.preferred_currency,deleted_at=NULL,updated_at=now(),version=konektag.user_preferences.version+1`,[user.id,currency]);
 return Response.json({currency});
};
