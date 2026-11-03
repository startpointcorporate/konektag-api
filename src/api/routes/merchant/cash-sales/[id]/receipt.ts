import type { RouteHandler } from '../../../../http';
import { resendCashReceipt } from '../../../../../application/services/merchant-cash-service.ts';
import { cashActor,cashBody,cashHttp,cashJson,cashScope } from '../../../../../application/merchant-cash-http.ts';
export const POST:RouteHandler=({url,request,locals,params})=>cashHttp(async()=>{
  const actor=cashActor(locals),scope=cashScope(url);await cashBody(request);
  return cashJson(await resendCashReceipt(actor,scope,params.id||'',request.headers.get('X-Idempotency-Key')),202);
});
