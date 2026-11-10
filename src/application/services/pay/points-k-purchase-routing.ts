/**
 * Points K purchase: before the checkout is created, the server routes the
 * buyer's residence country (recorded at registration) to its Konektag site
 * and reads the payment context and fees there. The browser does not choose
 * the country or the site. Fee calculation rules are unchanged.
 */
import { routeKonektagFlow, type KonektagSiteRoute } from '../../shared/konektag-site.ts';
import { paymentContextResolver, type PaymentContext } from './payment-context-resolver.ts';

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export class PointsKPurchaseRoutingError extends Error {
  constructor(readonly code: 'BUYER_NOT_FOUND' | 'PAYMENT_CURRENCY_MISMATCH') { super(code); }
}

export async function routePointsKPurchase(
  userId: string,
  deps: { database?: Queryable; resolver?: Pick<typeof paymentContextResolver, 'resolveForRoute'> } = {},
): Promise<{ route: KonektagSiteRoute; context: PaymentContext }> {
  const database = deps.database ?? (await import('../../../infrastructure/database/pool.ts')).default;
  const { rows: [user] } = await database.query(
    'SELECT legal_country FROM konektag.users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!user) throw new PointsKPurchaseRoutingError('BUYER_NOT_FOUND');
  const route = await routeKonektagFlow('points-k-purchase', user.legal_country ?? '');
  const context = await (deps.resolver ?? paymentContextResolver).resolveForRoute(route);
  return { route, context };
}
