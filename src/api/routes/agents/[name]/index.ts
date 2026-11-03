import type { RouteHandler } from '../../../http';
import { agentService } from '../../../../application/services/agent-service.ts';

export const GET: RouteHandler = async ({ params }) => {
  try {
    const agent = await agentService.getAgentDetail(params.name!);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(agent), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[agents/detail]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
