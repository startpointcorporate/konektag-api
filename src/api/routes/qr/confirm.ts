import type { RouteHandler } from '../../http';

// QR completion requires a Wallet OTP or a verified payment-provider event.
export const GET: RouteHandler = async () => {
  return new Response(JSON.stringify({ error: 'QR_OTP_CHECKOUT_REQUIRED' }), { status: 410 });
};
