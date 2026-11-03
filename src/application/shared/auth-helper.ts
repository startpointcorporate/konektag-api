import type { RouteHandler } from '../../api/http';
import { authService } from '../services/auth-service.ts';
import { tokenCookieOptions } from './cookie-utils.ts';
import { userApiKeyService } from '../services/user-api-key-service.ts';

export async function getAuthPayload(request: Request, cookies: any, url: string): Promise<{ sub: string; email: string } | null> {
  const header = request.headers.get('authorization');
  if (header && /^token(?:\s|$)/i.test(header)) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return null;
    const identity = await userApiKeyService.authenticate(header);
    if (!identity || identity.user.access_status === 'BLOCKED') return null;
    return { sub: identity.user.keycloak_id, email: identity.user.email || identity.user.keycloak_id };
  }
  let token = cookies.get('konektag_access_token')?.value;
  if (!token) {
    const refreshToken = cookies.get('konektag_refresh_token')?.value;
    if (refreshToken) {
      try {
        const newTokens = await authService.refreshToken(refreshToken);
        token = newTokens.accessToken;
        cookies.set('konektag_access_token', token, tokenCookieOptions(url, 300));
      } catch {}
    }
  }
  if (!token) return null;
  try {
    const payload = await authService.validateToken(token);
    if (!payload) return null;
    return { sub: payload.sub as string, email: (payload.email as string) || (payload.sub as string) };
  } catch {
    return null;
  }
}
