import type { RouteHandler } from '../../../http';

export const POST: RouteHandler = async ({ request }) => {
  await request.text();
  console.info('PawaPay payout callback received but is not implemented');
  return Response.json({ error: 'PawaPay callback type not implemented' }, { status: 501 });
};
