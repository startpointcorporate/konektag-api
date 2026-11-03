import type { RouteHandler } from '../../../http';
import { communicationConsentService } from '../../../../application/services/communication-consent-service.ts';
import { isConsentChannel } from '../../../../domain/CommunicationConsent.ts';

export const GET: RouteHandler = async ({ params, url }) => {
  const channel = params.channel;
  if (!channel || !isConsentChannel(channel)) {
    return new Response(JSON.stringify({ error: 'Invalid channel' }), { status: 400 });
  }

  const userId = url.searchParams.get('userId');
  const token = url.searchParams.get('token');

  if (!userId || !token) {
    return new Response(JSON.stringify({ error: 'Missing userId or token' }), { status: 400 });
  }

  const secret = process.env.COMMUNICATION_UNSUBSCRIBE_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: 'Unsubscribe not configured' }), { status: 500 });
  }

  const expectedToken = await sha256(`${userId}:${channel}:${secret}`);
  if (token !== expectedToken) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 403 });
  }

  try {
    await communicationConsentService.updatePreference(
      userId,
      channel,
      'denied',
      'unsubscribe_link',
      null,
    );

    return new Response(`
      <!DOCTYPE html>
      <html><body style="font-family:sans-serif;text-align:center;padding:4rem">
        <h1>Désabonnement confirmé</h1>
        <p>Vous ne recevrez plus de communications par <strong>${channel}</strong>.</p>
        <p>Ce paramètre peut être modifié à tout moment depuis les paramètres de votre compte.</p>
      </body></html>
    `, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
