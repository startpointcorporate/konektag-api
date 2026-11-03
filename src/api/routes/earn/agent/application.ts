import type { RouteHandler } from '../../../http';
import { agentService } from '../../../../application/services/agent-service.ts';

export const GET: RouteHandler = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const merchantProfileId = url.searchParams.get('merchant_profile_id');
    if (!merchantProfileId) {
      return new Response(JSON.stringify({ error: 'merchant_profile_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const application = await agentService.getMyApplication(user.id, merchantProfileId);
    return new Response(JSON.stringify(application), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[agent/application]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
