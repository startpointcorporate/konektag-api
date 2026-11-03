import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';
import { MerchantProSubscriptionService } from './merchant-pro-subscription-service.ts';

export type CapabilityCode = 'marketplace.profile' | 'payment.qr' | 'payment.link' |
  'analytics.essential' | 'analytics.detailed' | 'analytics.export' | 'catalog.prepare' | 'catalog.manage' | 'promotion.active' |
  'promotion.manage' | 'integration.api' | 'integration.webhook' | 'integration.revoke' | 'membership.manage';
export type SubscriptionState = 'ABSENT' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'INACTIVE' | 'CANCELLED';
export type DecisionDatabase = Pick<Pool, 'query'>;
export interface EntitlementDecision {
  allowed: boolean;
  reasonCode: string;
  actorId: string;
  merchantId: string;
  capability: CapabilityCode;
  subscriptionState: SubscriptionState;
  quota?: { limit: number; consumed: number; remaining: number };
  correlationId: string;
}
export interface EntitlementRequest {
  actorId: string;
  merchantId: string;
  capability: CapabilityCode;
  occurredAt?: Date;
  requestedUnits?: number;
}
const FREE = new Set<CapabilityCode>([
  'marketplace.profile', 'payment.qr', 'payment.link', 'analytics.essential', 'catalog.prepare',
  'promotion.active', 'promotion.manage', 'integration.revoke', 'membership.manage',
]);
const CAPABILITIES = new Set<CapabilityCode>([...FREE, 'analytics.detailed', 'analytics.export', 'catalog.manage', 'integration.api', 'integration.webhook']);

export class EntitlementDecisionService {
  constructor(private database: DecisionDatabase = pool) {}

  async decide(request: EntitlementRequest, db = this.database): Promise<EntitlementDecision> {
    const decision = this.initial(request);
    if (!request.actorId) return this.finish(decision, 'NOT_AUTHENTICATED');
    const { rows: [merchant] } = await db.query(
      `SELECT mp.id, mp.user_id, mm.role, mm.status, mm.id AS membership_id
       FROM konektag.merchant_profiles mp
       LEFT JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id AND mm.user_id = $2
       WHERE mp.id = $1 AND mp.deleted_at IS NULL`, [request.merchantId, request.actorId]);
    if (!merchant) return this.finish(decision, 'MERCHANT_NOT_FOUND');
    // A suspended membership must never fall back to legacy ownership.
    const authorized = merchant.membership_id
      ? merchant.status === 'active' && ['owner', 'manager'].includes(merchant.role)
      : merchant.user_id === request.actorId;
    if (!authorized) return this.finish(decision, 'MEMBERSHIP_DENIED');
    return this.policy(request, decision, db);
  }

  /** Only call after authenticating a merchant API key on the server. */
  async decideForApiPrincipal(merchantId: string, db = this.database): Promise<EntitlementDecision> {
    const request: EntitlementRequest = { actorId: `merchant-api:${merchantId}`, merchantId, capability: 'integration.api' };
    const decision = this.initial(request);
    const { rows } = await db.query('SELECT id FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL', [merchantId]);
    if (!rows.length) return this.finish(decision, 'MERCHANT_NOT_FOUND');
    return this.policy(request, decision, db);
  }

  private initial(request: EntitlementRequest): EntitlementDecision {
    return { allowed: false, reasonCode: 'CAPABILITY_NOT_INCLUDED', actorId: request.actorId,
      merchantId: request.merchantId, capability: request.capability, subscriptionState: 'ABSENT', correlationId: randomUUID() };
  }

  private async policy(request: EntitlementRequest, decision: EntitlementDecision, db: DecisionDatabase) {
    if (!CAPABILITIES.has(request.capability)) return this.finish(decision, 'CAPABILITY_NOT_INCLUDED');
    const resolution = await new MerchantProSubscriptionService(db).resolveSubscription(request.merchantId, request.occurredAt ?? new Date());
    decision.subscriptionState = resolution.state;
    if (!FREE.has(request.capability) && resolution.state !== 'ACTIVE') {
      return this.finish(decision, resolution.state === 'EXPIRED' ? 'SUBSCRIPTION_EXPIRED' : 'SUBSCRIPTION_INACTIVE');
    }
    if (request.capability === 'promotion.active' && resolution.state !== 'ACTIVE') {
      const { rows: [row] } = await db.query('SELECT COUNT(*)::int AS consumed FROM konektag.promotions WHERE merchant_id = $1 AND is_active = true', [request.merchantId]);
      const consumed = Number(row.consumed);
      decision.quota = { limit: 1, consumed, remaining: Math.max(0, 1 - consumed) };
      if (consumed + (request.requestedUnits ?? 1) > 1) return this.finish(decision, 'QUOTA_EXHAUSTED');
    }
    if (request.capability === 'membership.manage' && resolution.state === 'ACTIVE') {
      const { rows: [row] } = await db.query(
        "SELECT COUNT(*)::int AS consumed FROM konektag.merchant_memberships WHERE merchant_profile_id = $1 AND status = 'active' AND role = 'manager'", [request.merchantId]);
      const consumed = Number(row.consumed);
      decision.quota = { limit: 1, consumed, remaining: Math.max(0, 1 - consumed) };
      if ((request.requestedUnits ?? 0) > 0 && consumed + request.requestedUnits! > 1) return this.finish(decision, 'QUOTA_EXHAUSTED');
    }
    return this.finish(decision, 'ALLOWED');
  }

  private finish(decision: EntitlementDecision, reasonCode: string) {
    decision.reasonCode = reasonCode;
    decision.allowed = reasonCode === 'ALLOWED';
    console.info('[entitlement]', { capability: decision.capability, merchantId: decision.merchantId,
      allowed: decision.allowed, reasonCode, correlationId: decision.correlationId });
    return decision;
  }
}
export const entitlementDecisionService = new EntitlementDecisionService();
export function entitlementStatus(decision: EntitlementDecision): number {
  return ({ NOT_AUTHENTICATED: 401, MERCHANT_NOT_FOUND: 404, QUOTA_EXHAUSTED: 429 } as Record<string, number>)[decision.reasonCode] ?? 403;
}
export function entitlementResponse(decision: EntitlementDecision): Response {
  return new Response(JSON.stringify({ error: decision.reasonCode, decision }), {
    status: entitlementStatus(decision), headers: { 'Content-Type': 'application/json' },
  });
}
export class EntitlementDeniedError extends Error {
  readonly status: number;
  constructor(readonly decision: EntitlementDecision) {
    super(decision.reasonCode); this.status = entitlementStatus(decision);
  }
}
export async function requireEntitlement(actorId: string, merchantId: string, capability: CapabilityCode, db?: DecisionDatabase, requestedUnits?: number) {
  const decision = await entitlementDecisionService.decide({ actorId, merchantId, capability, requestedUnits }, db);
  if (!decision.allowed) throw new EntitlementDeniedError(decision);
  return decision;
}
