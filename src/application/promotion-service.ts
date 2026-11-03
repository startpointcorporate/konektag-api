import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../infrastructure/database/pool.ts';
import { requireEntitlement } from './services/entitlement-decision-service.ts';

export interface Promotion {
  id: string;
  merchantId: string;
  title: string;
  description?: string;
  imageUrl?: string;
  category: string;
  discountType: string;
  discountValue: number;
  startDate: string;
  endDate?: string;
  terms?: string;
  isActive: boolean;
  createdBy?: string;
  createdAt: string;
}

export interface PromotionSnapshot {
  id: string;
  merchantId: string;
  title: string;
  category: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  startDate: string;
  endDate?: string;
  isActive: boolean;
  fingerprint: string;
}

function promotionSnapshot(row: any): PromotionSnapshot {
  const value = Number(row.discount_value);
  const snapshot = {
    id: row.id,
    merchantId: row.merchant_id,
    title: row.title,
    category: row.category,
    discountType: row.discount_type,
    discountValue: value,
    startDate: new Date(row.start_date).toISOString(),
    ...(row.end_date ? { endDate: new Date(row.end_date).toISOString() } : {}),
    isActive: Boolean(row.is_active),
  } satisfies Omit<PromotionSnapshot, 'fingerprint'>;
  return { ...snapshot, fingerprint: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

export async function loadActivePromotion(client: PoolClient, merchantId: string, promotionId: string, now = new Date()): Promise<PromotionSnapshot> {
  const { rows: [row] } = await client.query(
    `SELECT id, merchant_id, title, category, discount_type, discount_value, start_date, end_date, is_active
     FROM konektag.promotions WHERE id=$1 AND merchant_id=$2 FOR SHARE`, [promotionId, merchantId]);
  if (!row) throw new Error('PROMOTION_NOT_FOUND');
  const snapshot = promotionSnapshot(row);
  if (!snapshot.isActive || new Date(snapshot.startDate) > now || (snapshot.endDate && new Date(snapshot.endDate) <= now)) {
    throw new Error('PROMOTION_NOT_APPLICABLE');
  }
  if (!['percentage', 'fixed'].includes(snapshot.discountType) || snapshot.discountValue <= 0 ||
      (snapshot.discountType === 'percentage' && snapshot.discountValue > 100)) {
    throw new Error('INVALID_PROMOTION');
  }
  return snapshot;
}

export async function listActivePromotions(client: PoolClient, merchantId: string, now = new Date()): Promise<PromotionSnapshot[]> {
  const { rows } = await client.query(
    `SELECT id, merchant_id, title, category, discount_type, discount_value, start_date, end_date, is_active
     FROM konektag.promotions WHERE merchant_id=$1 AND is_active=true AND start_date <= $2
       AND (end_date IS NULL OR end_date > $2) ORDER BY created_at DESC, id`, [merchantId, now]);
  return rows.map(promotionSnapshot);
}

function mapRow(row: any): Promotion {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    category: row.category,
    discountType: row.discount_type,
    discountValue: parseFloat(row.discount_value),
    startDate: row.start_date,
    endDate: row.end_date,
    terms: row.terms,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export class PromotionService {

  async listActiveByMerchant(merchantId: string, now = new Date()): Promise<PromotionSnapshot[]> {
    const { rows } = await pool.query(
      `SELECT id, merchant_id, title, category, discount_type, discount_value, start_date, end_date, is_active
       FROM konektag.promotions
       WHERE merchant_id=$1 AND is_active=true AND start_date <= $2 AND (end_date IS NULL OR end_date > $2)
       ORDER BY created_at DESC, id`, [merchantId, now]);
    return rows.map(promotionSnapshot);
  }

  async getMerchantProfileId(userId: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT mp.id FROM konektag.merchant_profiles mp
       LEFT JOIN konektag.merchant_memberships mm ON mm.merchant_profile_id = mp.id AND mm.user_id = $1
       WHERE mp.deleted_at IS NULL AND ((mm.status = 'active' AND mm.role IN ('owner','manager'))
         OR (mm.id IS NULL AND mp.user_id = $1))
       ORDER BY mm.is_primary DESC NULLS LAST, mp.created_at DESC, mp.id DESC LIMIT 1`,
      [userId],
    );
    if (!rows.length) throw new Error('MERCHANT_NOT_FOUND');
    return rows[0].id;
  }

  async listByMerchant(userId: string): Promise<Promotion[]> {
    const merchantId = await this.getMerchantProfileId(userId);
    const { rows } = await pool.query(
      `SELECT * FROM konektag.promotions WHERE merchant_id = $1 ORDER BY created_at DESC`,
      [merchantId],
    );
    return rows.map(mapRow);
  }

  async create(userId: string, input: {
    title: string;
    description?: string;
    category?: string;
    discountType: string;
    discountValue: number;
    startDate: string;
    endDate?: string;
  }): Promise<Promotion> {
    const merchantId = await this.getMerchantProfileId(userId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM konektag.merchant_profiles WHERE id = $1 FOR UPDATE', [merchantId]);
      await requireEntitlement(userId, merchantId, 'promotion.active', client);
      const { rows } = await client.query(
        `INSERT INTO konektag.promotions (merchant_id, title, description, category, discount_type, discount_value, start_date, end_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [merchantId, input.title, input.description ?? null, input.category ?? 'general',
         input.discountType, input.discountValue, input.startDate, input.endDate ?? null, userId]);
      await client.query('COMMIT');
      return mapRow(rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async update(userId: string, promotionId: string, input: {
    title?: string;
    description?: string;
    category?: string;
    discountType?: string;
    discountValue?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<Promotion> {
    const merchantId = await this.getMerchantProfileId(userId);
    await requireEntitlement(userId, merchantId, 'promotion.manage');
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const settable: [string, keyof typeof input][] = [
      ['title', 'title'],
      ['description', 'description'],
      ['category', 'category'],
      ['discount_type', 'discountType'],
      ['discount_value', 'discountValue'],
      ['start_date', 'startDate'],
      ['end_date', 'endDate'],
    ];
    for (const [col, key] of settable) {
      if (input[key] !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(input[key]);
      }
    }
    if (!fields.length) throw new Error('NO_FIELDS');
    values.push(promotionId, merchantId);
    const { rows } = await pool.query(
      `UPDATE konektag.promotions SET ${fields.join(', ')} WHERE id = $${idx++} AND merchant_id = $${idx} RETURNING *`,
      values,
    );
    if (!rows.length) throw new Error('NOT_FOUND');
    return mapRow(rows[0]);
  }

  async toggleActive(userId: string, promotionId: string): Promise<Promotion> {
    const merchantId = await this.getMerchantProfileId(userId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM konektag.merchant_profiles WHERE id = $1 FOR UPDATE', [merchantId]);
      await requireEntitlement(userId, merchantId, 'promotion.manage', client);
      const { rows: [promotion] } = await client.query(
        'SELECT is_active FROM konektag.promotions WHERE id = $1 AND merchant_id = $2', [promotionId, merchantId]);
      if (!promotion) throw new Error('NOT_FOUND');
      if (!promotion.is_active) await requireEntitlement(userId, merchantId, 'promotion.active', client);
      const { rows: [updated] } = await client.query(
        'UPDATE konektag.promotions SET is_active = NOT is_active WHERE id = $1 AND merchant_id = $2 RETURNING *', [promotionId, merchantId]);
      await client.query('COMMIT');
      return mapRow(updated);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async delete(userId: string, promotionId: string): Promise<void> {
    const merchantId = await this.getMerchantProfileId(userId);
    await requireEntitlement(userId, merchantId, 'promotion.manage');
    const { rowCount } = await pool.query(
      `DELETE FROM konektag.promotions WHERE id = $1 AND merchant_id = $2`,
      [promotionId, merchantId],
    );
    if (!rowCount) throw new Error('NOT_FOUND');
  }
}

export const promotionService = new PromotionService();
