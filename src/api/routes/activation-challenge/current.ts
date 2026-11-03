import type { RouteHandler } from '../../http';
import { activationChallengeService } from '../../../application/services/activation-challenge-service.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
  const challenge = await activationChallengeService.currentChallenge(user.id);
  return new Response(JSON.stringify({ challenge }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
