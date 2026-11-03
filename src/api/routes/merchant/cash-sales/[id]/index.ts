import type { RouteHandler } from '../../../../http';
import { cashSaleDetails } from '../../../../../application/services/merchant-cash-service.ts';
import { cashActor,cashHttp,cashJson,cashScope } from '../../../../../application/merchant-cash-http.ts';
export const GET:RouteHandler=({url,locals,params})=>cashHttp(async()=>cashJson(await cashSaleDetails(cashActor(locals),cashScope(url),params.id||'')));
