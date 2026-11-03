import type { RouteHandler } from '../../../../http';

// This endpoint bypassed the regulated P03 acquisition flow. It is retained
// only to return an explicit retirement response to old browser clients.
export const POST: RouteHandler = async () => new Response(JSON.stringify({
  error: 'LEGACY_MOBILE_MONEY_CONFIRMATION_RETIRED',
  message: 'Use /api/admin/mobile-money/acquisitions with maker-checker evidence.',
}), { status: 410, headers: { 'Content-Type': 'application/json' } });
