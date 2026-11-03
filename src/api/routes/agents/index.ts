import type { RouteHandler } from '../../http';
import { agentService } from '../../../application/services/agent-service.ts';

export const GET: RouteHandler = async ({ url }) => {
  try {
    const country = url.searchParams.get('country') || undefined;
    const city = url.searchParams.get('city') || undefined;
    const area = url.searchParams.get('area') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const agents = await agentService.getAgents({ country, city, area, limit });
    return new Response(JSON.stringify(agents), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[agents/list]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
