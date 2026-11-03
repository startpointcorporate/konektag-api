import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { quoteCatalog } from '../../../application/public-catalog-service.ts';
import { operationsJson, operationsError } from '../../../application/merchant-operations-http.ts';
export const POST:RouteHandler=async({request})=>{
 try{return operationsJson(await quoteCatalog(await request.json()));}
 catch(e){return e instanceof z.ZodError?operationsJson({error:'INVALID_CART'},422):operationsError(e);}
};
