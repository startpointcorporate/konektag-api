import type { RouteHandler } from '../../http';
import { onboardingService } from '../../../application/services/onboarding-service.ts';
import { OnboardingError } from '../../../domain/DomainErrors.ts';
import { z } from 'zod';

const VerifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export const POST: RouteHandler = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const parsed = VerifyOtpSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ errors: parsed.error.flatten().fieldErrors }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const verified = await onboardingService.verifyOtp(parsed.data.email, parsed.data.code);
    if (!verified) {
      throw new OnboardingError('INVALID_OTP');
    }
    return new Response(
      JSON.stringify({ message: 'OTP verified' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    if (error instanceof OnboardingError) {
      const humanMessages: Record<string, string> = {
        OTP_TOO_MANY_ATTEMPTS: 'Trop de tentatives. Veuillez demander un nouveau code.',
        OTP_EXPIRED: 'Le code de vérification a expiré.',
      };
      return new Response(
        JSON.stringify({ error: error.code, message: humanMessages[error.code] || error.message }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    console.error('[verify-otp]', error);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
