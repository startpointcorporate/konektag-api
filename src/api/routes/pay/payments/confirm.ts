import type { RouteHandler } from '../../../http';

// Payment completion must be driven by the OTP-protected checkout or a verified
// provider event, never by a bearer token in a browser URL.
export const GET: RouteHandler = async () => {
  return new Response(JSON.stringify({ error: 'UNIFIED_PAYMENT_CHECKOUT_REQUIRED' }), { status: 410 });
};
