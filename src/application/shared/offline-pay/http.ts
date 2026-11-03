import type { RequestContext } from '../../../api/http';
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
export async function offlineRequest(context: RequestContext, work: (user: string, body: unknown) => Promise<unknown>) {
  if (!context.locals.user) return json({ error: 'UNAUTHORIZED' }, 401);
  if (context.request.headers.get('origin') !== context.url.origin) return json({ error: 'ORIGIN_DENIED' }, 403);
  if (!context.request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'CONTENT_TYPE' }, 415);
  const reader = context.request.body?.getReader();
  if (!reader) return json({ error: 'BODY_REQUIRED' }, 400);
  let bytes = 0, body = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2100000) { await reader.cancel(); return json({ error: 'BODY_TOO_LARGE' }, 413); }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    return json(await work(context.locals.user.id, JSON.parse(body)));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'SUBMITTER_DENIED' || message === 'DEVICE_DENIED') return json({ error: 'DEVICE_DENIED' }, 403);
    if (message === 'BATCH_CONFLICT') return json({ error: message }, 409);
    if (error instanceof SyntaxError || (error as any)?.name === 'ZodError') return json({ error: 'INVALID_OFFLINE_REQUEST' }, 400);
    return json({ error: 'OFFLINE_SYNC_UNAVAILABLE' }, 503);
  }
}
