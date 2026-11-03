import type { RequestContext } from '../api/http';
import { CashError, cashUuid } from '../domain/merchant-cash.ts';
export function cashJson(value:unknown,status=200):Response {
  return Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
}
export async function cashHttp(action:()=>Promise<Response>):Promise<Response> {
  try{return await action();}catch(error){
    if(error instanceof CashError)return cashJson({error:error.code},error.status);
    console.error('[merchant-cash] Operation failed');
    return cashJson({error:'CASH_SERVER_ERROR'},500);
  }
}
export async function cashBody(request:Request):Promise<Record<string,unknown>> {
  if(!request.headers.get('content-type')?.includes('application/json'))throw new CashError('CASH_JSON_REQUIRED',415);
  let body:unknown;try{body=await request.json();}catch{throw new CashError('CASH_INVALID_JSON',400);}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new CashError('CASH_INVALID_JSON',400);
  return body as Record<string,unknown>;
}
export function cashActor(locals:RequestContext['locals']):string {
  if(!locals.user?.id)throw new CashError('UNAUTHORIZED',401);
  return locals.user.id;
}
export function cashScope(url:URL):string{return cashUuid(url.searchParams.get('merchantProfileId'));}
