import type {RouteHandler} from '../../http';
import {z} from 'zod';
import {CartSchema} from '../../../domain/public-catalog.ts';
import {quoteCatalog} from '../../../application/public-catalog-service.ts';
import {createCoreTransaction} from '../../../application/core-transaction-service.ts';
import {paymentLinkService} from '../../../application/services/payment-link-service.ts';
import {operationsJson,operationsError} from '../../../application/merchant-operations-http.ts';
import pool from '../../../infrastructure/database/pool.ts';
const schema=z.object({cart:CartSchema,requestKey:z.string().uuid()}).strict();
export const POST:RouteHandler=async({locals,request})=>{
 if(!locals.user)return operationsJson({error:'Connectez-vous pour accéder au paiement.'},401);
 const parsed=schema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return operationsJson({error:'INVALID_CART'},422);
 try{
 const {cart,requestKey}=parsed.data;await quoteCatalog(cart);
 const id=await createCoreTransaction({merchantProfileId:cart.merchantProfileId,customerUserId:locals.user.id,catalogCheckout:true,kind:'ORDER',requestKey:`catalog:${requestKey}`,lines:cart.lines.map(l=>({...l,label:'Catalogue'}))});
 const {rows:[snapshot]}=await pool.query(`SELECT total_minor,currency FROM konektag.core_transactions WHERE id=$1 AND customer_user_id=$2`,[id,locals.user.id]);
 const link=await paymentLinkService.create({merchantProfileId:cart.merchantProfileId,amountMinor:Number(snapshot.total_minor),currency:snapshot.currency,description:'Catalogue Konektag',reference:id,expiration:new Date(Date.now()+30*60000),catalog:{transactionId:id}});
 return operationsJson({url:`/fr/catalog-checkout/${link.url_slug}/`},201);
 }catch(e){return operationsError(e);}
};
