import type { RouteHandler } from '../../http';
import { cardBatchService } from '../../../application/services/card-batch-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentification requise.' }), { status: 401 });

  try {
    const body = await request.json();
    const { number, pin } = body;

    if (!number || !pin) return new Response(JSON.stringify({ error: 'INVALID', message: 'Numéro de Carte K et PIN requis.' }), { status: 400 });
    if (!/^\d{16}$/.test((number as string).replace(/\s/g, ''))) return new Response(JSON.stringify({ error: 'INVALID', message: 'Numéro de Carte K invalide (16 chiffres).' }), { status: 400 });
    if (!/^\d{6}$/.test(pin as string)) return new Response(JSON.stringify({ error: 'INVALID', message: 'PIN invalide (6 chiffres).' }), { status: 400 });

    const ip = (locals as any).clientAddress || request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '';
    const ua = request.headers.get('user-agent') || '';

    const result = await cardBatchService.redeemCard(number as string, pin as string, user.id, user.keycloak_id, ip, ua);
    return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', message: e.message }), { status: 500 });
  }
};
