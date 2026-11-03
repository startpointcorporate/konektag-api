import type { RouteHandler } from '../../../http';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentification requise.' }), { status: 401 });
  return new Response(JSON.stringify({ error: 'CARD_SALE_DECLARATION_REQUIRED', message: 'Utilisez la declaration de vente avec la liste des cartes et la preuve.' }), { status: 410, headers: { 'Content-Type': 'application/json' } });
};
