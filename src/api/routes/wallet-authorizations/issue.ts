import type { RouteHandler } from '../../http';

// Browser callers must use a source-specific endpoint that derives its snapshot server-side.
export const POST: RouteHandler = async () => new Response(JSON.stringify({ error: 'ENDPOINT_DISABLED' }), {
  status: 410,
  headers: { 'Content-Type': 'application/json' },
});
