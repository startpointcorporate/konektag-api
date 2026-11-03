import type { RouteHandler } from '../../../../http';
import pool from '../../../../../infrastructure/database/pool.ts';
import { MerchantProSubscriptionService } from '../../../../../application/services/merchant-pro-subscription-service.ts';
import { entitlementDecisionService, entitlementResponse, type CapabilityCode } from '../../../../../application/services/entitlement-decision-service.ts';
import { renewalOpensAt } from '../../../../../application/services/subscription-pricing.ts';

export const GET: RouteHandler = async ({ params, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  try {
    const merchantId = params.profileId!;
    const now = new Date();
    const request = { actorId: locals.user.id, merchantId, occurredAt: now };
    const access = await entitlementDecisionService.decide({ ...request, capability: 'marketplace.profile' });
    if (!access.allowed) return entitlementResponse(access);
    const { state, subscription } = await new MerchantProSubscriptionService(pool).resolveSubscription(merchantId, now);
    const capabilities: CapabilityCode[] = ['catalog.manage', 'analytics.export', 'integration.api', 'integration.webhook', 'promotion.active'];
    const decisions = Object.fromEntries(await Promise.all(capabilities.map(async capability =>
      [capability, await entitlementDecisionService.decide({ ...request, capability, requestedUnits: 1 })])));
    const daysRemaining = subscription?.subscription_end
      ? Math.ceil((new Date(subscription.subscription_end).getTime() - now.getTime()) / 86400000) : null;
    return new Response(JSON.stringify({ hasPro: state === 'ACTIVE', status: state, decisions,
      startDate: subscription?.subscription_start ?? null, endDate: subscription?.subscription_end ?? null,
      type: subscription?.subscription_type ?? null, renewalRequested: subscription?.renewal_requested ?? false,
      daysRemaining, canRenew: !!subscription?.subscription_end &&
        (state === 'EXPIRED' || (state === 'ACTIVE' && subscription?.subscription_type &&
          now >= renewalOpensAt(new Date(subscription.subscription_end), subscription.subscription_type))),
      cancellationScheduled: !!subscription?.cancelled_at,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
