import type { RouteHandler } from '../../http';
import { difyAdapter } from '../../../infrastructure/adapters/dify-adapter.ts';

export const GET: RouteHandler = async () => {
  try {
    const difyHealth = await difyAdapter.health();
    return new Response(JSON.stringify({
      status: 'healthy',
      dify: {
        status: difyHealth.status,
        version: difyHealth.version,
      },
      timestamp: new Date().toISOString(),
    }), { status: 200 });
  } catch (err) {
    console.error('[dify-health]', err);
    return new Response(JSON.stringify({
      status: 'degraded',
      dify: {
        status: 'unreachable',
      },
      timestamp: new Date().toISOString(),
    }), { status: 503 });
  }
};
