import type { RouteHandler } from '../../http';
import { merchantApiKeyService } from '../../../application/services/merchant-api-key-service.ts';
import { merchantService } from '../../../application/merchant-service.ts';
import { merchantActivationService } from '../../../application/services/merchant-activation-service.ts';
import { entitlementDecisionService, entitlementResponse } from '../../../application/services/entitlement-decision-service.ts';

const VALID_ENVS = ['sandbox', 'live'] as const;

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profile = await merchantService.getProfile(user.id);
    const decision = await entitlementDecisionService.decide({ actorId: user.id, merchantId: profile.id, capability: 'integration.revoke' });
    if (!decision.allowed) return entitlementResponse(decision);
    const keys = await merchantApiKeyService.getKeyInfo(profile.id);
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error.message?.includes('NOT_FOUND')) {
      return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    }
    console.error('[merchant/api-key]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profile = await merchantService.getProfile(user.id);
    const activation = await merchantActivationService.requireMerchantApproved(profile.id);
    if (!activation.ok) return new Response(JSON.stringify({ error: activation.error }), { status: 403 });

    const decision = await entitlementDecisionService.decide({ actorId: user.id, merchantId: profile.id, capability: 'integration.api' });
    if (!decision.allowed) return entitlementResponse(decision);

    const body = await request.json();
    const env: string = body.environment || 'sandbox';

    if (!VALID_ENVS.includes(env as any)) {
      return new Response(JSON.stringify({ error: 'environment must be sandbox or live' }), { status: 400 });
    }

    const result = await merchantApiKeyService.createKey(profile.id, env as 'sandbox' | 'live');
    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[merchant/api-key]', error);
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 500 });
  }
};

export const DELETE: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profile = await merchantService.getProfile(user.id);

    const decision = await entitlementDecisionService.decide({ actorId: user.id, merchantId: profile.id, capability: 'integration.revoke' });
    if (!decision.allowed) return entitlementResponse(decision);

    const body = await request.json();
    const env: string = body.environment || 'sandbox';

    if (!VALID_ENVS.includes(env as any)) {
      return new Response(JSON.stringify({ error: 'environment must be sandbox or live' }), { status: 400 });
    }

    await merchantApiKeyService.revokeKey(profile.id, env as 'sandbox' | 'live');
    return new Response(null, { status: 204 });
  } catch (error: any) {
    console.error('[merchant/api-key]', error);
    return new Response(JSON.stringify({ error: error.message || 'SERVER_ERROR' }), { status: 500 });
  }
};
