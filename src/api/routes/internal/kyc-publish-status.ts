import type { RouteHandler } from '../../http';
import { redisAdapter } from '../../../infrastructure/adapters/redis-adapter.ts';

export const POST: RouteHandler = async ({ request }) => {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (token !== process.env.INTERNAL_API_TOKEN) {
    return new Response(null, { status: 401 });
  }

  try {
    const { user_id, status, details } = await request.json();
    await redisAdapter.publishKycStatus(user_id, { status, ...details, timestamp: new Date().toISOString() });
    return new Response(null, { status: 204 });
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400 });
  }
};
