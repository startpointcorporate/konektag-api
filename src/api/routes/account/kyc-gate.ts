import type { RouteHandler } from '../../http';
import pool from '../../../infrastructure/database/pool.ts';
import { checkUserKycVerified } from '../../../application/services/user-kyc-gate-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user?.id) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  const result = await checkUserKycVerified(pool, user.id);
  return Response.json({ verified: result.verified, state: result.state });
};
