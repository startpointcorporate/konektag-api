import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { merchantService } from '../../../application/merchant-service.ts';
import {
  apiPaymentWebhookService,
  ApiPaymentWebhookValidationError,
} from '../../../application/services/pay/api-payment-webhook-service.ts';
import { entitlementDecisionService, entitlementResponse } from '../../../application/services/entitlement-decision-service.ts';

const EndpointSchema = z.object({
  environment: z.enum(['sandbox', 'live']),
  url: z.string().max(2_048),
});

const RotateSchema = z.object({
  environment: z.enum(['sandbox', 'live']),
  action: z.literal('rotate-secret'),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: RouteHandler = async ({ locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  try {
    const profile = await merchantService.getProfile(locals.user.id);
    const decision = await entitlementDecisionService.decide({ actorId: locals.user.id, merchantId: profile.id, capability: 'integration.revoke' });
    if (!decision.allowed) return entitlementResponse(decision);
    return json({ endpoints: await apiPaymentWebhookService.listEndpoints(profile.id) });
  } catch (error) {
    console.error('[merchant/api-webhook GET]', error);
    return json({ error: 'SERVER_ERROR' }, 500);
  }
};

export const PUT: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const parsed = EndpointSchema.safeParse(body);
  if (!parsed.success) return json({ errors: parsed.error.flatten().fieldErrors }, 422);

  try {
    const profile = await merchantService.getProfile(locals.user.id);

    const decision = await entitlementDecisionService.decide({ actorId: locals.user.id, merchantId: profile.id, capability: parsed.data.url.trim() ? 'integration.webhook' : 'integration.revoke' });
    if (!decision.allowed) return entitlementResponse(decision);

    return json(await apiPaymentWebhookService.updateEndpoint(profile.id, parsed.data.environment, parsed.data.url));
  } catch (error) {
    if (error instanceof ApiPaymentWebhookValidationError) return json({ error: error.message }, 422);
    console.error('[merchant/api-webhook PUT]', error);
    return json({ error: 'SERVER_ERROR' }, 500);
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const parsed = RotateSchema.safeParse(body);
  if (!parsed.success) return json({ errors: parsed.error.flatten().fieldErrors }, 422);

  try {
    const profile = await merchantService.getProfile(locals.user.id);

    const decision = await entitlementDecisionService.decide({ actorId: locals.user.id, merchantId: profile.id, capability: 'integration.webhook' });
    if (!decision.allowed) return entitlementResponse(decision);

    return json(await apiPaymentWebhookService.rotateSecret(profile.id, parsed.data.environment));
  } catch (error) {
    console.error('[merchant/api-webhook POST]', error);
    return json({ error: 'SERVER_ERROR' }, 500);
  }
};
