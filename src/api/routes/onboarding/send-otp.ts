import type { RouteHandler } from '../../http';
import { redisAdapter } from '../../../infrastructure/adapters/redis-adapter.ts';
import { emailService } from '../../../application/services/resend-service.ts';
import { z } from 'zod';

const SendOtpSchema = z.object({
  email: z.string().email(),
  firstName: z.string().optional().default(''),
  locale: z.enum(['fr','en','ar','pt','es','sw','ha','yo','zh','hi']).optional().default('fr'),
});

export const POST: RouteHandler = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const parsed = SendOtpSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ errors: parsed.error.flatten().fieldErrors }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    // No existing user required for OTP; send regardless of DB state.
    const code = await redisAdapter.setOtp(parsed.data.email);
    const lang = parsed.data.locale === 'en' ? 'en' : 'fr';

    const templateVars: Record<string, string> = {
      firstName: parsed.data.firstName,
      currentYear: new Date().getFullYear().toString(),
      code,
    };
    await emailService.sendTemplate('otpCode', lang, parsed.data.email.trim().toLowerCase(), templateVars);

    return new Response(
      JSON.stringify({ message: 'Email de confirmation envoyé' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[send-otp]', error);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
