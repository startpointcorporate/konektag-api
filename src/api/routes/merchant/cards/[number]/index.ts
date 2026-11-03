import type { RouteHandler } from '../../../../http';
import { cardBatchService } from '../../../../../application/services/card-batch-service.ts';

export const GET: RouteHandler = async ({ params, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  if (!await cardBatchService.isAgent(user.id)) {
    return new Response(JSON.stringify({ error: 'FORBIDDEN', message: 'Seul un commerçant Agent peut consulter une Carte K.' }), { status: 403 });
  }

  const number = params.number as string;
  if (!number) return new Response(JSON.stringify({ error: 'INVALID' }), { status: 400 });

  const card = await cardBatchService.getCardByNumber(number.replace(/\s/g, ''));
  if (!card) return new Response(JSON.stringify({ success: false, message: 'Carte K introuvable.' }), { status: 404 });

  return new Response(JSON.stringify({
    success: true,
    number: card.number,
    amount: card.amount,
    status: card.status,
    countryCode: card.country_code,
    sold_at: card.sold_at,
    qr_code: card.qr_code,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
