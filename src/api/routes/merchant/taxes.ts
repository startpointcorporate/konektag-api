import type { RouteHandler } from '../../http';
import {nativeCatalogRetired} from '../../../domain/native-catalog-retirement.ts';
import { listMerchantTaxes } from '../../../application/merchant-tax-service.ts';

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
function errorResponse(error: unknown) {
  const code = error instanceof Error ? error.message : 'SERVER_ERROR';
  const status = code === 'MERCHANT_ACCESS_DENIED' || code === 'PRODUCT_NOT_OWNED' ? 403
    : code === 'VERSION_CONFLICT' ? 409 : code.startsWith('INVALID') || code === 'INVALID_PRICING_RULE' ? 422 : 500;
  if (status === 500) console.error('[merchant/taxes]', error);
  return response({ error: status === 500 ? 'SERVER_ERROR' : code }, status);
}

export const GET: RouteHandler = async ({ locals, url }) => {
  if (!locals.user) return response({ error: 'UNAUTHORIZED' }, 401);
  const merchantProfileId = url.searchParams.get('merchantProfileId');
  if (!merchantProfileId) return response({ error: 'INVALID_QUERY' }, 422);
  try { return response({ taxes: await listMerchantTaxes(locals.user.id, merchantProfileId, url.searchParams.get('productId') ?? undefined) }); }
  catch (error) { return errorResponse(error); }
};

export const POST:RouteHandler=async({locals})=>locals.user?nativeCatalogRetired():response({error:'UNAUTHORIZED'},401);
