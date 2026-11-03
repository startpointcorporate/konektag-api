import type { RouteHandler } from '../../http';
import { difyAdapter, type DifyChatRequest } from '../../../infrastructure/adapters/dify-adapter.ts';

export const POST: RouteHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { query, profile, conversation_id } = body;

    if (!query) return new Response(JSON.stringify({ error: 'Query required' }), { status: 400 });

    const inputs: Record<string, unknown> = {};
    if (profile && profile !== 'general') {
      inputs.profile = profile;
    }

    const chatRequest: DifyChatRequest = {
      query,
      user: profile || 'anonymous',
      inputs,
      response_mode: 'blocking',
    };
    if (conversation_id) chatRequest.conversation_id = conversation_id;

    const response = await difyAdapter.chat(chatRequest);
    return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[chat]', e.message);
    return new Response(JSON.stringify({ error: e.message || 'Service unavailable' }), { status: 502 });
  }
};
