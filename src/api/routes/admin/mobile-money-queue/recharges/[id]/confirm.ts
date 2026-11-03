import type { RouteHandler } from '../../../../../http';

export const POST: RouteHandler = async () => new Response(JSON.stringify({
  error: 'LEGACY_MOBILE_MONEY_CONFIRMATION_RETIRED',
  message: 'Use /api/admin/mobile-money/acquisitions with maker-checker evidence.',
}), { status: 410, headers: { 'Content-Type': 'application/json' } });
