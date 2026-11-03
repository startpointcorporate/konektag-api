import type { RouteHandler } from '../../http';
import { communicationConsentService } from '../../../application/services/communication-consent-service.ts';
import { isConsentChannel, ALL_CHANNELS } from '../../../domain/CommunicationConsent.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  const userId = user.keycloak_id || user.id;

  try {
    const preferences = await communicationConsentService.getPreferences(userId);
    return new Response(JSON.stringify({ preferences }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const PUT: RouteHandler = async ({ locals, request }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  const userId = user.keycloak_id || user.id;

  try {
    const body = await request.json();
    if (!body.preferences || !Array.isArray(body.preferences)) {
      return new Response(JSON.stringify({ error: 'Invalid payload: preferences array required' }), { status: 400 });
    }

    for (const pref of body.preferences) {
      if (!isConsentChannel(pref.channel) || !['granted', 'denied'].includes(pref.status)) {
        return new Response(
          JSON.stringify({ error: `Invalid channel or status: ${pref.channel}/${pref.status}` }),
          { status: 400 },
        );
      }
    }

    const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

    await communicationConsentService.updateMultiple(
      userId,
      body.preferences,
      'settings',
      ipAddress,
    );

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
