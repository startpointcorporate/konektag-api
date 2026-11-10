import type { Middleware } from '../http';
import { authService } from '../../application/services/auth-service.ts';
import pool from '../../infrastructure/database/pool.ts';
import { tokenCookieOptions } from '../../application/shared/cookie-utils.ts';
import { HttpIdempotencyService, isFinancialMutation } from '../../application/services/http-idempotency-service.ts';
import { HttpIdempotencyRepository } from '../../infrastructure/repositories/http-idempotency-repository.ts';
import { merchantApiKeyService } from '../../application/services/merchant-api-key-service.ts';
import { authenticateUserApiRequest } from '../../application/shared/user-api-auth.ts';
import { financialRequestFingerprint, requiresLegalEntityScope, resolveFinancialRouteKey } from '../../application/services/financial-idempotency-scope.ts';


async function resolveLegalEntityForCountry(country: string): Promise<{ id: string; code: string } | null> {
  const { rows: [entity] } = await pool.query(
    `SELECT id, code FROM konektag.legal_entities
     WHERE country_code = $1 AND status = 'APPROVED' AND deleted_at IS NULL
     ORDER BY code LIMIT 1`,
    [country],
  );
  return entity ? { id: entity.id, code: entity.code } : null;
}

// Accounting worker is started as a standalone process (see accounting-worker-entry.ts)
// Workers run as independent processes; HTTP instances never start dispatchers.

const PUBLIC_PREFIXES = [
  '/auth/callback',
  '/auth/login',
  '/api/onboarding/',
  '/api/internal/health',
  '/api/preferences/features',
  '/api/countries',
  '/api/merchant/media-file',
  '/api/merchant/qr-code-file',
  '/api/pay/checkout/',
  // Hosted checkout is a public capability URL: the opaque checkout token authorizes access.
  // Keep the rest of /pay protected.
  '/pay/checkout',
  '/api/pay/payment-context',
  '/api/pay/payment-country',
  '/api/pay/countries',
  '/api/pay/detected-country',
  // Frappe sites authenticate as themselves in the handler (site key + token), never as a user.
  '/api/integrations/frappe/',
];

const PUBLIC_EXACT_PATHS = [
  '/api/pay/payments',
  '/api/webhooks/stripe',
];

const PROTECTED_PREFIXES = [
  '/api/merchant/visibility',
  '/api/merchant/cash-sales',
  '/api/device-identity',
  '/dashboard',
  '/account',
  '/api/account',
  '/api/recharge/',
  '/api/k/send',
  '/api/kyc/',
  '/api/preferences/save',
  '/api/preferences/complete',
  '/api/merchant/profile',
  '/api/merchant/claim',
  '/api/merchant/my-profiles',
  '/api/merchant/qrcode',
  '/api/merchant/qr-codes',
  '/api/merchant/qr-code',
  '/api/merchant/publish',
  '/api/merchant/unpublish',
  '/api/merchant/suspend',
  '/api/merchant/media',
  '/api/merchant/links',
  '/api/merchant/opening-hours',
  '/api/merchant/restaurant',
  '/api/merchant/hotel',
  '/api/merchant/commerce',
  '/api/merchant/products',
  '/api/merchant/promotions',
  '/api/merchant/api-key',
  '/merchant',
  '/admin',
  '/api/admin',
  '/send-k',
  '/qr',
  '/pay',
  '/api/qr',
  '/api/pay',
  '/api/wallet-authorizations/',
  '/settings',
  '/earn',
  '/favorites',
  '/api/favorites',
  '/api/earn/',
  '/api/activation-challenge',
  '/api/cards/',
  '/api/users',
  '/api/orders',
  '/api/bookings',
  '/api/transactions',
  '/api/loyalty',
  '/api/reviews',
  '/api/referral',
  '/api/consent',
];

const STATIC_ASSETS = ['.js', '.css', '.svg', '.png', '.jpg', '.ico', '.woff2'];

function stripLocale(pathname: string): string {
  // Strip leading locale prefix like /fr/, /en/, /ar/ etc.
  return pathname.replace(/^\/[a-z]{2}\//, '/');
}

function isPublicRoute(pathname: string): boolean {
  if (STATIC_ASSETS.some(ext => pathname.endsWith(ext))) return true;
  // Strip locale prefix before checking protection
  const stripped = stripLocale(pathname);
  if (PUBLIC_EXACT_PATHS.includes(pathname) || PUBLIC_EXACT_PATHS.includes(stripped)) return true;
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p) || stripped.startsWith(p))) return true;
  if (!PROTECTED_PREFIXES.some(p => stripped.startsWith(p))) return true;
  return false;
}



export const onRequest = ((async (context, routeNext) => {
  const outgoing = !['GET','HEAD','OPTIONS'].includes(context.request.method)
    && /^\/api\/(k\/send|qr\/request-confirmation|pay\/pay-link|pay\/checkout\/[^/]+\/(confirm|funding|wallet-authorization)|wallet-authorizations)(\/|$)/.test(context.url.pathname);
  const financialReviewResponse = async () => {
    // Financial safety is independent from authentication, KYC and onboarding.
    if (outgoing && context.locals.user) {
      const { rows: [control] } = await pool.query(`SELECT c.status,COALESCE(c.source_alert_id::text,c.party_id::text) AS reference
        FROM konektag.financial_account_controls c JOIN konektag.parties p ON p.id=c.party_id
        JOIN konektag.users u ON u.keycloak_id=p.keycloak_id WHERE u.id=$1`, [context.locals.user.id]);
      if (control && control.status !== 'ACTIVE') return Response.json({error:'ACCOUNT_FINANCIAL_REVIEW',reference:control.reference,
        message:'Certaines opérations sont temporairement indisponibles. Votre solde et votre historique restent accessibles.'}, {status:423});
    }
    return null;
  };
  const next = async () => {
    const review = await financialReviewResponse();
    if (review) return review;
    const response = await routeNext();
    // Preserve the same API error for a hold applied concurrently with the request.
    if (outgoing && response.status >= 400) {
      const body = await response.clone().json().catch(() => null);
      if (JSON.stringify(body)?.includes('ACCOUNT_FINANCIAL_REVIEW')) return Response.json({error:'ACCOUNT_FINANCIAL_REVIEW',
        message:'Certaines opérations sont temporairement indisponibles. Consultez votre dashboard pour la référence support.'},{status:423});
    }
    return response;
  };
  const requestPath = new URL(context.request.url).pathname.replace(/\/+$/, '') || '/';
  const apiAuthError = await authenticateUserApiRequest(context);
  if (apiAuthError) return apiAuthError;
  // Accept Keycloak user JWTs for Swagger/OIDC API clients, without replacing
  // session cookies, user API keys or merchant-specific bearer credentials.
  // The decoded issuer is used only to identify token type; validateToken
  // always verifies the signature, issuer and expiry before trusting identity.
  const bearerMatch = context.request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i);
  const bearerToken = bearerMatch?.[1];
  if (bearerToken && requestPath.startsWith('/api/') && requestPath !== '/api/pay/payments') {
    let isKeycloakUserToken = false;
    try {
      const parts = bearerToken.split('.');
      if (parts.length === 3) {
        const untrusted = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const issuer = (process.env.KEYCLOAK_EXTERNAL_BASE_URL || 'https://login.konektag.eu').replace(/\/$/, '')
          + '/realms/' + (process.env.KEYCLOAK_REALM || 'konektag');
        isKeycloakUserToken = untrusted.iss === issuer;
      }
    } catch { /* Other bearer schemes retain their existing handlers. */ }
    if (isKeycloakUserToken) {
      const payload = await authService.validateToken(bearerToken);
      if (!payload || typeof payload.sub !== 'string') {
        return Response.json({error:'INVALID_OIDC_TOKEN'}, {status:401});
      }
      const { rows: [user] } = await pool.query(
        `SELECT id,keycloak_id,username,locale,state,role,profile_type,country,city,access_status
           FROM konektag.users WHERE keycloak_id=$1 AND deleted_at IS NULL`, [payload.sub]);
      if (!user) return Response.json({error:'USER_NOT_ONBOARDED'}, {status:401});
      (context.locals as any).user = {...user, email:payload.email};
      (context.locals as any).oidcBearerAuthenticated = true;
    }
  }
  if (context.locals.apiKeyId) {
    // Check current account/KYC restrictions before idempotency can replay a response.
    const apiStateError = await handleOnboardingRedirect(context, context.locals.user, async () => null);
    if (apiStateError) return apiStateError;
  }
  // Merchant payment endpoints authenticate before generic mutation middleware,
  // so callers never receive validation details without an API key.
  if (requestPath === '/api/pay/payments' && !context.request.headers.get('authorization')?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Populate authenticated user before financial-mutation/idempotency handling.
  // The idempotency gate runs before the normal auth section below; without this,
  // a valid signed-in dashboard request such as POST /api/pay/recharges can be
  // rejected as UNAUTHORIZED whenever the gate needs an actor.
  const earlyAccessToken = context.cookies.get('konektag_access_token')?.value;
  if (!(context.locals as any).user && earlyAccessToken) {
    try {
      let payload = await authService.validateToken(earlyAccessToken);
      if (!payload) throw new Error('Invalid token');
      const { rows:[user] } = await pool.query(
        `SELECT id,keycloak_id,username,locale,state,role,profile_type,country,city,access_status
         FROM konektag.users WHERE keycloak_id=$1 AND deleted_at IS NULL`, [payload.sub]);
      if (user) {
        (context.locals as any).user = { ...user, email: payload.email };
      }
    } catch {
      const earlyRefreshToken = context.cookies.get('konektag_refresh_token')?.value;
      if (earlyRefreshToken) {
        try {
          const newTokens = await authService.refreshToken(earlyRefreshToken);
          context.cookies.set('konektag_access_token', newTokens.accessToken, tokenCookieOptions(context.url.href,300));
          context.cookies.set('konektag_refresh_token', newTokens.refreshToken, tokenCookieOptions(context.url.href,30*24*3600));
          const payload = await authService.validateToken(newTokens.accessToken);
          if (payload) {
            const { rows:[user] } = await pool.query(
              `SELECT id,keycloak_id,username,locale,state,role,profile_type,country,city,access_status
               FROM konektag.users WHERE keycloak_id=$1 AND deleted_at IS NULL`, [payload.sub]);
            if (user) {
              (context.locals as any).user = { ...user, email: payload.email };
            }
          }
        } catch {}
      }
    }
  }

  const financialReview = await financialReviewResponse();
  if (financialReview) return financialReview;

  // ── HTTP Idempotency ──
  // All financial mutation routes require X-Idempotency-Key.
  // Idempotency is enforced via http_idempotency_requests table.
  const idempotencyPath = requestPath;
  if (isFinancialMutation(context.request.method, idempotencyPath)) {
    const routeKey = resolveFinancialRouteKey(idempotencyPath);
    if (!routeKey) return new Response(JSON.stringify({ error: 'FINANCIAL_ROUTE_NOT_REGISTERED' }), { status: 403 });
    const idemKey = context.request.headers.get('idempotency-key') ?? context.request.headers.get('x-idempotency-key');
    if (!idemKey) {
      return new Response(JSON.stringify({
        error: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'X-Idempotency-Key header is required for financial mutations',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let actorId = (context.locals as any).user?.id as string | undefined;
    let actorType: 'USER' | 'MERCHANT' = 'USER';
    let legalEntityId: string | undefined;
    if (context.locals.apiKeyId && requiresLegalEntityScope(idempotencyPath)) {
      const entity = await resolveLegalEntityForCountry((context.locals as any).user.country);
      legalEntityId = entity?.id;
      Object.assign((context.locals as any).user, {
        legal_entity_id: entity?.id ?? null, legal_entity_code: entity?.code ?? null,
      });
    }
    if (!actorId && idempotencyPath === '/api/pay/payments') {
      const rawKey = context.request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const merchant = await merchantApiKeyService.validateApiKey(rawKey);
      if (!merchant) {
        return new Response(JSON.stringify({ error: 'Invalid API key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      actorId = `merchant:${merchant.merchantId}`;
      actorType = 'MERCHANT';
      const { rows: [merchantProfile] } = await pool.query(
        'SELECT legal_entity_id FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL', [merchant.merchantProfileId],
      );
      legalEntityId = merchantProfile?.legal_entity_id;
      (context.locals as any).merchantApiIdentity = merchant;
    }
    if (!actorId) {
      const token = context.cookies.get('konektag_access_token')?.value;
      const payload = token ? await authService.validateToken(token) : null;
      if (!payload) {
        return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const { rows: [user] } = await pool.query(
        `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status
         FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
        [payload.sub],
      );
      if (!user) {
        return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      actorId = user.id;
      const entity = await resolveLegalEntityForCountry(user.country);
      legalEntityId = entity?.id;
      (context.locals as any).user = { ...user, email: payload.email, legal_entity_id: entity?.id ?? null, legal_entity_code: entity?.code ?? null };
    }
    if (!actorId) {
      return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }
    const requiresScope = requiresLegalEntityScope(idempotencyPath);
    if (requiresScope && !legalEntityId) {
      return new Response(JSON.stringify({ error: 'LEGAL_ENTITY_SCOPE_REQUIRED' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      });
    }
    const rawBody = await context.request.clone().text();

    const client = await pool.connect();
    try {
      const repo = new HttpIdempotencyRepository(client);
      const service = new HttpIdempotencyService(repo);

      const decision = requiresScope
        ? await (async () => {
          const fingerprint = financialRequestFingerprint(routeKey, actorType, actorId, legalEntityId!, rawBody);
          const scoped = await repo.insertOrGetFinancialConflict({ actorType, actorId, legalEntityId: legalEntityId!, routeKey }, idemKey, fingerprint);
          return scoped.inserted
            ? { action: 'PROCEED' as const, recordId: scoped.inserted.id }
            : scoped.hashConflict
              ? { action: 'CONFLICT' as const, recordId: null, errorResponse: new Response(JSON.stringify({ error: 'IDEMPOTENCY_KEY_REUSED' }), { status: 409 }) }
              : scoped.existing?.status === 'COMPLETED'
                ? { action: 'REPLAY' as const, recordId: scoped.existing.id, cachedResponse: new Response(scoped.existing.responseBody || '{}', { status: scoped.existing.responseStatus || 200 }) }
                : { action: 'IN_PROGRESS' as const, recordId: scoped.existing?.id ?? null, errorResponse: new Response(JSON.stringify({ error: 'OPERATION_IN_PROGRESS' }), { status: 409 }) };
        })()
        : await service.beforeHandler(actorId, context.request.method, idempotencyPath, idemKey, rawBody);

      if (decision.cachedResponse) return decision.cachedResponse;
      if (decision.errorResponse) return decision.errorResponse;

      const response = await next();

      try {
        const responseBody = await response.clone().text();
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => { headers[k] = v; });
        await service.afterHandler(
          decision.recordId!,
          response.status,
          headers,
          responseBody
        );
      } catch { /* best effort - idempotency recording is non-blocking */ }

      return response;
    } catch (err) {
      console.error('[Middleware] Idempotency error:', err instanceof Error ? err.message : String(err));
      return new Response(JSON.stringify({
        error: 'IDEMPOTENCY_UNAVAILABLE',
        message: 'Financial mutation cannot proceed while idempotency storage is unavailable',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    } finally {
      client.release();
    }
  }

  // Clear cookies after Keycloak logout redirect
  if (context.url.searchParams.get('logout') === '1') {
    context.cookies.delete('konektag_access_token', { path: '/' });
    context.cookies.delete('konektag_refresh_token', { path: '/' });
    context.cookies.delete('konektag_code_verifier', { path: '/' });
    context.cookies.delete('konektag_id_token', { path: '/' });
    context.cookies.set('konektag_force_login', '1', { path: '/', maxAge: 3600 });
  }

  const { url, cookies } = context;
  // API credentials use the same account-state, KYC and route authorization gates.
  // Financial idempotency and account holds above have already been evaluated.
  if (context.locals.apiKeyId) return next();
  if ((context.locals as any).oidcBearerAuthenticated) return handleOnboardingRedirect(context, context.locals.user, next);

  const isPublic = isPublicRoute(url.pathname);
  const anonymousLinkRead = async () => context.request.method === 'GET'
    && /^\/api\/pay\/payment-links\/?$/.test(url.pathname) && url.searchParams.get('slug') ? next() : null;

  // Merchant API-key authentication is complete authentication for
  // merchant API endpoints such as /api/pay/payments.
  if ((context.locals as any).merchantApiIdentity) {
    return next();
  }

  // Try soft auth for public routes. Checkout URLs are public because the opaque
  // token is the payment capability, but when a signed-in customer's access
  // token has expired we must still refresh it: wallet-recharge ownership checks
  // use locals.user and must not suddenly fail with UNAUTHORIZED mid-checkout.
  let tokenCookie = cookies.get('konektag_access_token')?.value;
  let softAuthResolved = false;
  if (isPublic && tokenCookie) {
    try {
      const payload = await authService.validateToken(tokenCookie);
      if (payload) {
        const { rows: [user] } = await pool.query(
          `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
          [payload.sub],
        );
        if (user) {
          (context.locals as any).user = { ...user, email: payload.email };
          softAuthResolved = true;
        }
      }
    } catch {
      const refreshToken = cookies.get('konektag_refresh_token')?.value;
      if (refreshToken) {
        try {
          const newTokens = await authService.refreshToken(refreshToken);
          cookies.set('konektag_access_token', newTokens.accessToken, tokenCookieOptions(context.url.href, 300));
          cookies.set('konektag_refresh_token', newTokens.refreshToken, tokenCookieOptions(context.url.href, 30 * 24 * 3600));
          tokenCookie = newTokens.accessToken;
          const payload = await authService.validateToken(newTokens.accessToken);
          if (payload) {
            const { rows: [user] } = await pool.query(
              `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
              [payload.sub],
            );
            if (user) {
              (context.locals as any).user = { ...user, email: payload.email };
              softAuthResolved = true;
            }
          }
        } catch {
          // Public checkout remains usable anonymously if the session cannot be refreshed.
        }
      }
    }
  }

  // Resolve an authenticated session once for protected routes as well.
  // In particular, an expired access token must be refreshed before protected
  // APIs such as /api/auth/me are allowed to fall through to the 401 path.
  if (!softAuthResolved && tokenCookie) {
    try {
      let payload = await authService.validateToken(tokenCookie);
      if (!payload) throw new Error('Invalid token');
      const { rows: [user] } = await pool.query(
        `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
        [payload.sub],
      );
      if (user) {
        (context.locals as any).user = { ...user, email: payload.email };
        softAuthResolved = true;
        if (!isPublic) return handleOnboardingRedirect(context, user, next);
      }
    } catch {
      const refreshToken = cookies.get('konektag_refresh_token')?.value;
      if (refreshToken) {
        try {
          const newTokens = await authService.refreshToken(refreshToken);
          cookies.set('konektag_access_token', newTokens.accessToken, tokenCookieOptions(context.url.href, 300));
          cookies.set('konektag_refresh_token', newTokens.refreshToken, tokenCookieOptions(context.url.href, 30 * 24 * 3600));
          tokenCookie = newTokens.accessToken;
          const payload = await authService.validateToken(newTokens.accessToken);
          if (payload) {
            const { rows: [user] } = await pool.query(
              `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
              [payload.sub],
            );
            if (user) {
              (context.locals as any).user = { ...user, email: payload.email };
              softAuthResolved = true;
              if (!isPublic) return handleOnboardingRedirect(context, user, next);
            }
          }
        } catch {
          // Normal protected-route handling below will return 401/login.
        }
      }
    }
  }

  if (isPublic) {
    return next();
  }

  const token = cookies.get('konektag_access_token')?.value;

  if (!token) {
    const refreshToken = cookies.get('konektag_refresh_token')?.value;
    if (refreshToken) {
      try {
        const newTokens = await authService.refreshToken(refreshToken);
        cookies.set('konektag_access_token', newTokens.accessToken,
          tokenCookieOptions(context.url.href, 300));
        cookies.set('konektag_refresh_token', newTokens.refreshToken,
          tokenCookieOptions(context.url.href, 30 * 24 * 3600));

        const payload = await authService.validateToken(newTokens.accessToken);
        if (payload) {
          const { rows: [user] } = await pool.query(
            `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
            [payload.sub],
          );
          if (user) {
            (context.locals as any).user = { ...user, email: payload.email };
            return handleOnboardingRedirect(context, user, next);
          }
        }
      } catch {
        // Refresh failed, redirect to login
      }
    }
    const consultation = await anonymousLinkRead();
    if (consultation) return consultation;
    if (context.url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  try {
    const payload = await authService.validateToken(token);
    if (!payload) throw new Error('Invalid token');

    const { rows: [user] } = await pool.query(
      `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [payload.sub],
    );
    if (!user) throw new Error('User not found');

    (context.locals as any).user = { ...user, email: payload.email };
    return handleOnboardingRedirect(context, user, next);
  } catch {
    // An access token can still be present in the cookie while expired. In that
    // case use the refresh token exactly as we do when the access token is absent,
    // instead of returning 401 and leaving an already-rendered dashboard unable
    // to call its protected APIs.
    const refreshToken = cookies.get('konektag_refresh_token')?.value;
    if (refreshToken) {
      try {
        const newTokens = await authService.refreshToken(refreshToken);
        cookies.set('konektag_access_token', newTokens.accessToken,
          tokenCookieOptions(context.url.href, 300));
        cookies.set('konektag_refresh_token', newTokens.refreshToken,
          tokenCookieOptions(context.url.href, 30 * 24 * 3600));

        const refreshedPayload = await authService.validateToken(newTokens.accessToken);
        if (refreshedPayload) {
          const { rows: [refreshedUser] } = await pool.query(
            `SELECT id, keycloak_id, username, locale, state, role, profile_type, country, city, access_status
             FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
            [refreshedPayload.sub],
          );
          if (refreshedUser) {
            (context.locals as any).user = { ...refreshedUser, email: refreshedPayload.email };
            return handleOnboardingRedirect(context, refreshedUser, next);
          }
        }
      } catch {
        // Refresh failed; fall through to the normal unauthorized/login path.
      }
    }

    const consultation = await anonymousLinkRead();
    if (consultation) return consultation;
    if (context.url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
}) satisfies Middleware);

// Routes API restreintes tant que le KYC n'est pas validé
const KYC_RESTRICTED_API_PREFIXES = [
  '/api/k/send',
  '/api/qr',
  '/api/pay',
  '/api/wallet-authorizations',
];

function isKycRestrictedRoute(pathname: string): boolean {
  return KYC_RESTRICTED_API_PREFIXES.some(p => pathname.startsWith(p));
}

const KYC_RESTRICTED_STATES = ['KYC_PENDING', 'KYC_PROCESSING', 'KYC_PENDING_REVIEW', 'KYC_REJECTED', 'KYC_SKIPPED'];

async function handleOnboardingRedirect(context: any, user: any, next: any) {
  const pathname = context.url.pathname;

  if (user.access_status === 'BLOCKED') {
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'ACCOUNT_BLOCKED', message: 'Votre compte est bloque. Contactez le support.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return Response.json({ error: 'ACCOUNT_BLOCKED' }, { status: 403 });
  }

  // Restreindre les opérations de paiement/envoi de K tant que le KYC n'est pas validé
  if (pathname.startsWith('/api/') && isKycRestrictedRoute(pathname)) {
    if (KYC_RESTRICTED_STATES.includes(user.state)) {
      return new Response(JSON.stringify({
        error: 'KYC_REQUIRED',
        message: 'Votre compte est en cours de validation. Vous pouvez acheter des K, mais les paiements et envois de K seront disponibles après validation de votre identité.',
        kycStatus: user.state,
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Ne jamais rediriger les appels API (le client gère l'erreur lui-même)
  if (pathname.startsWith('/api/')) {
    return next();
  }

  return next();
}
