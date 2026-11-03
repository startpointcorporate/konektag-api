import type { RouteHandler } from '../../http';
import { onboardingService } from '../../../application/services/onboarding-service.ts';
import { OnboardingError } from '../../../domain/DomainErrors.ts';

export const POST: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    await onboardingService.completeOnboarding(user.id);
    return new Response(
      JSON.stringify({ message: 'Onboarding completed', redirect: 'dashboard' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    if (error instanceof OnboardingError) {
      return new Response(
        JSON.stringify({ error: error.code, message: error.message }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    console.error('[preferences/complete]', error);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
