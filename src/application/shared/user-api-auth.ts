import type { RequestContext } from '../../api/http';
import { userApiKeyService } from '../services/user-api-key-service.ts';

const error = (code: string, status: number) => Response.json({ error: code }, {
  status, headers: { 'Cache-Control': 'no-store' },
});

/** Authenticate before financial gates; invalid credentials never fall back to cookies. */
export async function authenticateUserApiRequest(context: Pick<RequestContext, 'request' | 'url' | 'locals'>): Promise<Response | null> {
  const header = context.request.headers.get('authorization');
  if (!header || !/^token(?:\s|$)/i.test(header)) return null;
  if (!context.url.pathname.startsWith('/api/')) return error('API_CREDENTIALS_REQUIRE_API_ROUTE', 401);
  try {
    const identity = await userApiKeyService.authenticate(header);
    if (!identity) return error('INVALID_API_CREDENTIALS', 401);
    if (identity.user.access_status === 'BLOCKED') return error('ACCOUNT_BLOCKED', 403);
    context.locals.user = identity.user;
    context.locals.apiKeyId = identity.keyId;
    return null;
  } catch {
    // Never log request headers, credentials or decrypted user data.
    return error('API_AUTH_UNAVAILABLE', 503);
  }
}
