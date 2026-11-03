import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { quoteOnePointK } from '../../../application/services/points-k-valuation-service.ts';
import { kPointsBalance } from '../../../application/services/k-points-service.ts';
import { currencyForCountry } from '../../../application/services/operation-currency-service.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  const sender=(locals as any).user;
  const senderIdentity=sender?.keycloak_id || sender?.id;
  if(!senderIdentity) return Response.json({error:'UNAUTHORIZED'},{status:401});
  const recipientId=new URL(request.url).searchParams.get('recipientId');
  if(!recipientId) return Response.json({error:'RECIPIENT_REQUIRED'},{status:400});
  const client=await pool.connect();
  try {
    const {rows:[senderRow]}=await client.query(
      `SELECT u.id,u.country,p.id AS party_id
       FROM konektag.users u
       JOIN konektag.parties p ON p.keycloak_id=u.keycloak_id AND p.party_type='individual' AND p.is_active=true
       WHERE (u.id::text=$1 OR u.keycloak_id::text=$1) AND u.deleted_at IS NULL
       LIMIT 1`,[String(senderIdentity)]);
    const {rows:[recipient]}=await client.query(
      `SELECT u.id,u.username,u.country
       FROM konektag.users u WHERE u.id=$1 AND u.deleted_at IS NULL LIMIT 1`,[recipientId]);
    if(!senderRow||!recipient) return Response.json({error:'USER_CURRENCY_UNAVAILABLE'},{status:409});
    const senderCurrency=currencyForCountry(senderRow.country);
    const recipientCurrency=currencyForCountry(recipient.country);
    const balance=await kPointsBalance(senderRow.party_id,client);
    const senderQuote=await quoteOnePointK(senderCurrency,new Date(),client);
    const recipientQuote=senderCurrency===recipientCurrency
      ? senderQuote : await quoteOnePointK(recipientCurrency,new Date(),client);
    return Response.json({
      recipient:{id:recipient.id,name:recipient.username,currency:recipientCurrency},
      sender:{currency:senderCurrency},
      availableK:Math.max(0,Math.floor(Number(balance.available))),
      parity:{pointCode:'K',currency:'EUR',pointValue:1},
      senderQuote,recipientQuote,
      sameCurrency:senderCurrency===recipientCurrency,
    });
  } catch(error:any) {
    return Response.json({error:error?.code||error?.message||'QUOTE_UNAVAILABLE'},{status:409});
  } finally { client.release(); }
};
