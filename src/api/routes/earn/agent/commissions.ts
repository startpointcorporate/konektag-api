import type { RouteHandler } from '../../../http';
import { agentService } from '../../../../application/services/agent-service.ts';

export const GET: RouteHandler = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const ambassadorName = url.searchParams.get('ambassador_name');
    if (!ambassadorName) {
      return new Response(JSON.stringify({ error: 'ambassador_name required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const commissions = await agentService.getAgentCommissions(user.id, ambassadorName);
    return new Response(JSON.stringify(commissions), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[agent/commissions]', error);
    const status = error.message === 'FORBIDDEN_AGENT' ? 403 : 500;
    return new Response(JSON.stringify({ error: status === 403 ? 'FORBIDDEN' : 'SERVER_ERROR' }), { status, headers: { 'Content-Type': 'application/json' } });
  }
};
