import type { RouteHandler } from '../../../http';
import { recordCashSale,listCashSales } from '../../../../application/services/merchant-cash-service.ts';
import { cashActor,cashBody,cashHttp,cashJson,cashScope } from '../../../../application/merchant-cash-http.ts';
export const POST:RouteHandler=({request,locals})=>cashHttp(async()=>{
  const actor=cashActor(locals),input=await cashBody(request);
  const result=await recordCashSale(actor,input,request.headers.get('X-Idempotency-Key'));
  return cashJson(result,result.replayed?200:201);
});
export const GET:RouteHandler=({url,locals})=>cashHttp(async()=>{
  const actor=cashActor(locals),id=cashScope(url),page=Math.max(1,Math.min(100000,Number.parseInt(url.searchParams.get('page')||'1')||1));
  return cashJson(await listCashSales(actor,id,page));
});
