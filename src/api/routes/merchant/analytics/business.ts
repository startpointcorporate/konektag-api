import type { RouteHandler } from '../../../http';
import { cashActor,cashHttp,cashJson,cashScope } from '../../../../application/merchant-cash-http.ts';
import { merchantBusinessReport } from '../../../../application/services/merchant-business-report.ts';
export const GET:RouteHandler=async({locals,url})=>cashHttp(async()=>cashJson(await merchantBusinessReport(cashActor(locals),cashScope(url),url.searchParams.get('period')||'30d',url.searchParams.get('currency'))));
