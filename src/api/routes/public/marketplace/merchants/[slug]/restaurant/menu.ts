import type { RequestContext } from '../../../../../../http';
import { CACHED, capability, defaultDeps, json, unavailable, type TransactionDeps } from '../../../../../../../application/marketplace-transactions/http-handlers.ts';
import { orderModes } from '../../../../../../../application/marketplace-transactions/restaurant-modes.ts';
import { RestaurantError, menuOf } from '../../../../../../../application/marketplace-transactions/restaurant-orders.ts';

// Live Lumen menu behind a published restaurant capability, cached 60 s.
export const GET = async (ctx: RequestContext, deps?: TransactionDeps): Promise<Response> => {
  try {
    deps ??= await defaultDeps();
    const cap = await capability(deps, ctx.params.slug, 'restaurant');
    if (!cap) return json({ error: 'CAPABILITY_NOT_AVAILABLE' }, 404);
    const menu = await menuOf(deps.site(cap.site), cap, deps.now().toISOString().slice(0, 10));
    const modes = await orderModes(deps.site(cap.site), ctx.params.slug!, cap);
    return new Response(JSON.stringify({ currency: menu.currency, sections: menu.sections, orderModes: modes }), { status: 200, headers: CACHED });
  } catch (error) {
    if (error instanceof RestaurantError && error.code === 'RESTAURANT_UNAVAILABLE') return json({ error: 'RESTAURANT_UNAVAILABLE' }, 503);
    const down = unavailable('restaurant-menu', error);
    return json({ error: down.error }, 503, down.headers);
  }
};
