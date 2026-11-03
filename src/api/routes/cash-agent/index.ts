import type { RouteHandler } from '../../http';

const disabled = () => new Response(JSON.stringify({ error: 'CASH_AGENT_DISABLED', message: 'Le service depot ou retrait d especes est indisponible.' }), { status: 410, headers: { 'Content-Type': 'application/json' } });
export const GET: RouteHandler = disabled;
export const POST: RouteHandler = disabled;
