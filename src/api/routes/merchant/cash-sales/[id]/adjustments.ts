import type { RouteHandler } from '../../../../http';
import { adjustCashSale } from '../../../../../application/services/merchant-cash-service.ts';
import { cashActor,cashBody,cashHttp,cashJson,cashScope } from '../../../../../application/merchant-cash-http.ts';
export const POST:RouteHandler=({url,request,locals,params})=>cashHttp(async()=>{
  const actor=cashActor(locals),scope=cashScope(url),input=await cashBody(request);
  return cashJson({sale:await adjustCashSale(actor,scope,params.id||'',input,request.headers.get('X-Idempotency-Key'))});
});
