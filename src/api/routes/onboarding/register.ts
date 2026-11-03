import type { RouteHandler } from '../../http';
import { onboardingService } from '../../../application/services/onboarding-service.ts';
import { redisAdapter } from '../../../infrastructure/adapters/redis-adapter.ts';
import { OnboardingError } from '../../../domain/DomainErrors.ts';
import { tokenCookieOptions } from '../../../application/shared/cookie-utils.ts';
import { z } from 'zod';
import { legalDocumentService, LegalDocumentsUnavailableError } from '../../../application/services/legal-document-service.ts';

const RegisterSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  username: z.string().min(3).max(50).regex(/^[a-z0-9._-]+$/i),
  email: z.string().email().max(255),
  phone: z.string().optional().default(''),
  password: z.string().min(8).max(128),
  locale: z.enum(['fr','en','ar','pt','es','sw','ha','yo','zh','hi']),
  acceptedTerms: z.literal(true),
  legalCountry: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  legalDocuments: z.array(z.object({
    id: z.string().min(1), type: z.enum(['terms', 'privacy']), country: z.string().min(2),
    version: z.string().min(1), content: z.string().min(1), url: z.string().url(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })).length(2),
});

function resolveSecureCookie(request: Request): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  if (forwardedProto === 'http') return false;

  try {
    const reqUrl = new URL(request.url);
    const host = reqUrl.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false;
    }
    return reqUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

function setTokenCookies(context: any, request: Request, accessToken: string, refreshToken: string) {
  const secure = resolveSecureCookie(request);
  context.cookies.set('konektag_access_token', accessToken,
    { ...tokenCookieOptions(context.url?.href, 300), secure });
  context.cookies.set('konektag_refresh_token', refreshToken,
    { ...tokenCookieOptions(context.url?.href, 30 * 24 * 3600), secure });
}

export const POST: RouteHandler = async ({ request, cookies, url }) => {
  const idempotencyKey = request.headers.get('X-Idempotency-Key');
  if (!idempotencyKey) {
    return new Response(
      JSON.stringify({ error: 'X-Idempotency-Key header is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const firstField = Object.keys(fieldErrors)[0];
    const firstMsg = firstField ? fieldErrors[firstField as keyof typeof fieldErrors]?.[0] : 'Données invalides.';
    return new Response(
      JSON.stringify({ errors: fieldErrors, message: firstMsg }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    // Verify that the email was verified via OTP
    const isVerified = await redisAdapter.checkOtpVerification(parsed.data.email);
    if (!isVerified) {
      return new Response(
        JSON.stringify({ error: 'EMAIL_NOT_VERIFIED', message: 'L\'adresse email n\'a pas été vérifiée.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    await legalDocumentService.assertSelected(parsed.data.legalCountry, parsed.data.locale, parsed.data.legalDocuments);
    const result = await onboardingService.register(parsed.data, idempotencyKey);
    await redisAdapter.consumeOtpVerification(parsed.data.email);
    setTokenCookies({ cookies, url }, request, result.accessToken, result.refreshToken);

    return new Response(
      JSON.stringify({
        userId: result.user.id,
        username: result.user.username,
        state: result.user.state,
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    if (error instanceof LegalDocumentsUnavailableError) {
      return new Response(JSON.stringify({ error: 'legal_documents_unavailable', message: error.message }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if (error instanceof OnboardingError) {
      const humanMessages: Record<string, string> = {
        USERNAME_OR_EMAIL_EXISTS: "Cet email ou nom d'utilisateur existe déjà.",
        IDEMPOTENCY_CONFLICT: "Cette demande a déjà été traitée.",
        AUTHENTICATION_FAILED: 'Erreur lors de la connexion. Veuillez réessayer.',
        EMAIL_NOT_VERIFIED: 'L\'adresse email n\'a pas été vérifiée.',
      };
      return new Response(
        JSON.stringify({ error: error.code, message: humanMessages[error.code] || error.message }),
        { status: error.code === 'IDEMPOTENCY_CONFLICT' ? 409
          : error.code === 'USERNAME_OR_EMAIL_EXISTS' ? 409
          : error.code === 'EMAIL_NOT_VERIFIED' ? 400 : 422,
          headers: { 'Content-Type': 'application/json' } },
      );
    }
    console.error('[register]', error);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
