import type { RouteHandler } from '../../http';
import { preferencesService } from '../../../application/services/preferences-service.ts';
import { OnboardingError } from '../../../domain/DomainErrors.ts';
import { z } from 'zod';

const SaveSchema = z.object({
  featureKeys: z.array(z.string()).min(1),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ errors: parsed.error.flatten().fieldErrors }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    await preferencesService.savePreferences(user.id, parsed.data.featureKeys);
    return new Response(
      JSON.stringify({ message: 'Preferences saved' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    if (error instanceof OnboardingError) {
      return new Response(
        JSON.stringify({ error: error.code, message: error.message }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    console.error('[preferences/save]', error);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
