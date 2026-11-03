import type { RouteHandler } from '../../../../http';

export const POST: RouteHandler = async () => new Response(JSON.stringify({
  error: 'LEGACY_SETTLEMENT_CONFIRMATION_RETIRED',
  confirmRoute: '/api/admin/merchant-settlements/confirm',
}), { status: 410, headers: { 'Content-Type': 'application/json' } });
