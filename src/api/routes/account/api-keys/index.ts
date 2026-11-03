import type { RequestContext } from '../../../http';
import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import { userApiKeyService } from '../../../../application/services/user-api-key-service.ts';

const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
});

// The TLS proxy can forward HTTPS requests to Astro over HTTP. Host remains
// the browser's target authority; never trust Origin or X-Forwarded-Host as
// the source of that authority. Only allow HTTPS upgrading the internal scheme.
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const source = new URL(origin);
    if (source.origin !== origin || !['http:', 'https:'].includes(source.protocol)) return false;
    const target = new URL(request.url);
    const host = request.headers.get('host') || target.host;
    const authority = new URL(`${target.protocol}//${host}`);
    if (authority.host !== host || authority.username || authority.password || authority.pathname !== '/') return false;
    if (source.origin === authority.origin) return true;
    return target.protocol === 'http:' && source.protocol === 'https:'
      && source.host === authority.host;
  } catch {
    return false;
  }
}

// Creating/revoking credentials requires the dashboard session, never another API key.
export function managementGuard(request: Request, locals: RequestContext['locals'], mutation = false): Response | null {
  if (!locals.user) return json({ error: 'UNAUTHORIZED' }, 401);
  if (locals.apiKeyId) return json({ error: 'DASHBOARD_SESSION_REQUIRED' }, 403);
  if (locals.user.access_status === 'BLOCKED') return json({ error: 'ACCOUNT_BLOCKED' }, 403);
  if (mutation && !sameOrigin(request)) {
    return json({ error: 'ORIGIN_DENIED' }, 403);
  }
  return null;
}

const CreateKey = z.object({
  label: z.string().trim().min(1).max(100),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export const GET: RouteHandler = async ({ request, locals }) => {
  const denied = managementGuard(request, locals);
  if (denied) return denied;
  try {
    return json({ keys: await userApiKeyService.list(locals.user!.id) });
  } catch {
    return json({ error: 'API_KEY_LIST_FAILED' }, 503);
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const denied = managementGuard(request, locals, true);
  if (denied) return denied;
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return json({ error: 'JSON_REQUIRED' }, 415);
  }
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  const parsed = CreateKey.safeParse(body);
  if (!parsed.success) return json({ error: 'INVALID_REQUEST' }, 400);
  if (parsed.data.expires_at && Date.parse(parsed.data.expires_at) <= Date.now()) {
    return json({ error: 'EXPIRY_MUST_BE_FUTURE' }, 400);
  }
  try {
    return json(await userApiKeyService.create(locals.user!.id, parsed.data.label, parsed.data.expires_at ?? null), 201);
  } catch {
    return json({ error: 'API_KEY_CREATE_FAILED' }, 503);
  }
};
