import {catalogPath} from '../domain/public-catalog.ts';
import {requireCoreMerchantActor} from './core-transaction-service.ts';
import crypto from 'node:crypto';
import pool from '../infrastructure/database/pool.ts';
import { merchantService } from './merchant-service.ts';
import { requireEntitlement, type CapabilityCode } from './services/entitlement-decision-service.ts';

export type GrowthTargetType = 'catalog' | 'profile' | 'offer' | 'promotion' | 'checkout' | 'campaign' | 'content';
export type GrowthEventType = 'smart_qr_scan' | 'destination_opened' | 'offer_clicked' | 'promotion_clicked' | 'content_shared' | 'conversion';

type DestinationInput = {
  merchantId: string;
  targetType: GrowthTargetType;
  targetId?: string;
  targetRef?: string;
  channel?: string;
  expiresAt?: string | null;
  actorId: string;
};

function capabilityFor(targetType: GrowthTargetType): CapabilityCode {
  if (targetType === 'promotion' || targetType === 'campaign') return 'promotion.manage';
  if (targetType === 'offer' || targetType === 'catalog') return 'catalog.manage';
  if (targetType === 'checkout') return 'payment.link';
  return 'marketplace.profile';
}

async function assertTarget(merchantId: string, targetType: GrowthTargetType, targetId?: string, targetRef?: string) {
  if (targetType === 'profile' || targetType === 'catalog') {
    if (targetId !== merchantId) throw new Error('TARGET_NOT_FOUND');
    const { rows: [row] } = await pool.query(
      `SELECT id FROM konektag.merchant_profiles WHERE id = $1 AND status = 'Published' AND deleted_at IS NULL`, [merchantId]);
    if (!row) throw new Error('TARGET_NOT_ACTIVE');
    return;
  }
  if (targetType === 'promotion') {
    const { rows: [row] } = await pool.query(
      `SELECT id FROM konektag.promotions
       WHERE id = $1 AND merchant_id = $2 AND is_active = true AND start_date <= now()
         AND (end_date IS NULL OR end_date > now())`, [targetId, merchantId]);
    if (!row) throw new Error('TARGET_NOT_ACTIVE');
    return;
  }
  if (targetType === 'offer') {
    const { rows: [row] } = await pool.query(
      `SELECT id FROM konektag.merchant_products WHERE id = $1 AND merchant_profile_id = $2 AND deleted_at IS NULL`, [targetId, merchantId]);
    if (!row) throw new Error('TARGET_NOT_FOUND');
    return;
  }
  if (targetType === 'checkout') {
    const { rows: [row] } = await pool.query(
      `SELECT id FROM konektag.checkout_intents
       WHERE public_id = $1 AND merchant_profile_id = $2 AND source_type = 'payment_link'
         AND status = 'ISSUED' AND expiration > now()`, [targetRef, merchantId]);
    if (!row) throw new Error('TARGET_NOT_ACTIVE');
    return;
  }
  if (targetType === 'campaign') {
    const { rows: [row] } = await pool.query(
      `SELECT id FROM konektag.activation_campaigns
       WHERE id = $1 AND status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`, [targetId]);
    if (!row) throw new Error('TARGET_NOT_ACTIVE');
    return;
  }
  if (targetType === 'content') {
    const { rows: [row] } = await pool.query(
      `SELECT id FROM konektag.growth_shareable_contents
       WHERE id = $1 AND merchant_profile_id = $2 AND is_active = true
         AND (expires_at IS NULL OR expires_at > now())`, [targetId, merchantId]);
    if (!row) throw new Error('TARGET_NOT_ACTIVE');
    return;
  }
  throw new Error('INVALID_TARGET_TYPE');
}

async function resolveMerchantId(actorId: string, requestedMerchantId?: string) {
  const merchantId = requestedMerchantId ?? (await merchantService.getProfile(actorId)).id;
  await requireEntitlement(actorId, merchantId, 'marketplace.profile');
  return merchantId;
}

export async function createDestination(input: DestinationInput) {
  if(!['profile','catalog','offer'].includes(input.targetType))throw new Error('INVALID_TARGET_TYPE');
  const accessClient=await pool.connect();try{await requireCoreMerchantActor(accessClient,input.merchantId,input.actorId);}finally{accessClient.release();}
  const merchantId = await resolveMerchantId(input.actorId, input.merchantId);
  await requireEntitlement(input.actorId, merchantId, capabilityFor(input.targetType));
  await assertTarget(merchantId, input.targetType, input.targetId, input.targetRef);
  const { rows: [row] } = await pool.query(
    `INSERT INTO konektag.growth_destinations
      (merchant_profile_id, target_type, target_id, target_ref, channel, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, merchant_profile_id, target_type, target_id, target_ref, channel, attribution_id, is_active, expires_at, created_at`,
    [merchantId, input.targetType, input.targetId ?? null, input.targetRef ?? null,
      input.channel ?? 'link', input.expiresAt ?? null, input.actorId],
  );
  return row;
}

export async function createShareableContent(input: {
  actorId: string; merchantId: string; mediaId: string; targetType: 'profile' | 'offer' | 'promotion'; targetId: string; channel?: string; expiresAt?: string | null;
}) {
  const merchantId = await resolveMerchantId(input.actorId, input.merchantId);
  await assertTarget(merchantId, input.targetType, input.targetId);
  const { rows: [media] } = await pool.query(
    `SELECT id FROM konektag.merchant_media WHERE id = $1 AND merchant_profile_id = $2 AND deleted_at IS NULL`, [input.mediaId, merchantId]);
  if (!media) throw new Error('MEDIA_NOT_FOUND');
  const { rows: [row] } = await pool.query(
    `INSERT INTO konektag.growth_shareable_contents
      (merchant_profile_id, media_id, target_type, target_id, channel, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, merchant_profile_id, media_id, target_type, target_id, channel, is_active, expires_at, created_at`,
    [merchantId, input.mediaId, input.targetType, input.targetId, input.channel ?? 'share', input.expiresAt ?? null, input.actorId],
  );
  return row;
}

export async function resolveDestination(id: string, attributionId?: string) {
  const { rows: [destination] } = await pool.query(
    `SELECT d.*, mp.slug, mp.status AS merchant_status, mp.deleted_at AS merchant_deleted_at
     FROM konektag.growth_destinations d
     JOIN konektag.merchant_profiles mp ON mp.id = d.merchant_profile_id
     WHERE d.id = $1 AND d.is_active = true AND (d.expires_at IS NULL OR d.expires_at > now())`, [id]);
  if (!destination || destination.merchant_deleted_at || destination.merchant_status !== 'Published' ||
      (attributionId && attributionId !== destination.attribution_id)) throw new Error('DESTINATION_NOT_FOUND');
  await assertTarget(destination.merchant_profile_id, destination.target_type, destination.target_id, destination.target_ref);
  let path = `/fr/marketplace/${destination.slug}/`;
  if(destination.target_type==='catalog')path=catalogPath(destination.merchant_profile_id);
  else if (destination.target_type === 'checkout') path = `/fr/pay/checkout?link=${encodeURIComponent(destination.target_ref)}`;
  else if (destination.target_type === 'campaign') path = `/fr/?campaign=${encodeURIComponent(destination.target_id)}`;
  else if (destination.target_type === 'content') {
    const { rows: [content] } = await pool.query(
      `SELECT target_type, target_id FROM konektag.growth_shareable_contents WHERE id = $1`, [destination.target_id]);
    if (content?.target_type === 'promotion') path += `?promotionId=${encodeURIComponent(content.target_id)}`;
    else if (content?.target_type === 'offer') path += `?offerId=${encodeURIComponent(content.target_id)}`;
  } else if (destination.target_type === 'promotion') path += `?promotionId=${encodeURIComponent(destination.target_id)}`;
  else if (destination.target_type === 'offer') path = catalogPath(destination.merchant_profile_id,destination.target_id);
  const attribution = destination.attribution_id;
  return { ...destination, path: `${path}${path.includes('?') ? '&' : '?'}attribution=${encodeURIComponent(attribution)}` };
}

export async function recordEvent(input: {
  destinationId: string; attributionId: string; eventType: GrowthEventType; eventKey?: string; userId?: string | null; metadata?: Record<string, unknown>; conversionReference?: string | null;
}) {
  const destination = await resolveDestination(input.destinationId, input.attributionId);
  if (input.eventType === 'conversion') {
    if (!input.conversionReference) throw new Error('CONVERSION_REFERENCE_REQUIRED');
    const { rows: [tx] } = await pool.query(
      `SELECT id FROM konektag.core_transactions WHERE id::text = $1 AND merchant_profile_id = $2 AND state IN ('CONFIRMED','ALLOCATED','IN_PROGRESS','COMPLETED','CLOSED')`,
      [input.conversionReference, destination.merchant_profile_id]);
    if (!tx) {
      const { rows: [checkout] } = await pool.query(
        `SELECT id FROM konektag.checkout_intents WHERE public_id = $1 AND merchant_profile_id = $2 AND status = 'CONSUMED'`,
        [input.conversionReference, destination.merchant_profile_id]);
      if (!checkout) throw new Error('CONVERSION_NOT_CONFIRMED');
    }
  }
  const eventKey = input.eventKey ?? crypto.createHash('sha256').update(`${input.destinationId}:${input.attributionId}:${input.eventType}:${input.conversionReference ?? ''}`).digest('hex');
  const common = {
    merchantId: destination.merchant_profile_id, destinationId: input.destinationId, contentId: destination.target_type === 'content' ? destination.target_id : null,
    attributionId: destination.attribution_id, channel: destination.channel, userId: input.userId ?? null,
    promotionId: destination.target_type === 'promotion' ? destination.target_id : null, offerId: destination.target_type === 'offer' ? destination.target_id : null,
    campaignId: destination.target_type === 'campaign' ? destination.target_id : null,
  };
  if (destination.target_type === 'content') {
    const { rows: [content] } = await pool.query(
      `SELECT target_type, target_id FROM konektag.growth_shareable_contents WHERE id = $1`, [destination.target_id]);
    common.promotionId = content?.target_type === 'promotion' ? content.target_id : null;
    common.offerId = content?.target_type === 'offer' ? content.target_id : null;
  }
  const insert = async (eventType: GrowthEventType, key: string) => pool.query(
    `INSERT INTO konektag.growth_events
      (merchant_profile_id, destination_id, content_id, attribution_id, event_type, channel, user_id, promotion_id, offer_id, campaign_id, conversion_reference, event_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (merchant_profile_id, event_key) DO NOTHING RETURNING id`,
    [common.merchantId, common.destinationId, common.contentId, common.attributionId, eventType, common.channel,
      common.userId, common.promotionId, common.offerId, common.campaignId, input.conversionReference ?? null, key, JSON.stringify(input.metadata ?? {})]);
  const events = input.eventType === 'smart_qr_scan'
    ? await Promise.all([insert('smart_qr_scan', `${eventKey}:scan`), insert('destination_opened', `${eventKey}:open` )])
    : [await insert(input.eventType, eventKey)];
  return { accepted: events.some(result => (result.rowCount ?? 0) > 0), eventKey, merchantId: common.merchantId, attributionId: common.attributionId };
}
