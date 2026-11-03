import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { redisAdapter } from '../../../infrastructure/adapters/redis-adapter.ts';

export const GET: RouteHandler = async () => {
  const checks: Record<string, boolean> = {};

  // PostgreSQL
  try {
    await pool.query('SELECT 1');
    checks.postgresql = true;
  } catch { checks.postgresql = false; }

  // Redis
  try {
    checks.redis = await redisAdapter.ping();
  } catch { checks.redis = false; }

  const allOk = Object.values(checks).every(Boolean);
  return new Response(JSON.stringify({
    status: allOk ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  }), { status: allOk ? 200 : 503 });
};
