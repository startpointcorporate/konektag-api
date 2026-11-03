import type { Pool, PoolClient } from 'pg';
import { addProPeriod, proPrice, type ProPeriod } from './subscription-pricing.ts';

export type SubscriptionState = 'ABSENT' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'INACTIVE' | 'CANCELLED';
type SubscriptionDatabase = Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>;

export interface MerchantProSubscription {
  id: string;
  merchant_profile_id: string;
  subscription_start: Date;
  subscription_end: Date | null;
  subscription_type: 'MONTHLY' | 'ANNUAL';
  status: 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'CANCELLED';
  renewal_requested: boolean;
  renewal_type: 'MONTHLY' | 'ANNUAL' | null;
  auto_renew: boolean;
  annual_discount_applied: boolean;
  first_activation: boolean;
  created_at: Date;
  updated_at: Date;
  price_minor?: number | null;
  currency?: string | null;
  activated_by?: string | null;
  activated_at?: Date | null;
  cancelled_at?: Date | null;
}

export interface CreateMerchantProSubscriptionInput {
  merchant_profile_id: string;
  subscription_type: 'MONTHLY' | 'ANNUAL';
  subscription_start: Date;
  subscription_end: Date | null;
  auto_renew?: boolean;
  first_activation?: boolean;
}

export interface UpdateMerchantProSubscriptionInput {
  id: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'CANCELLED';
  subscription_end?: Date | null;
  renewal_requested?: boolean;
  renewal_type?: 'MONTHLY' | 'ANNUAL' | null;
  auto_renew?: boolean;
}

export interface GetProSubscriptionByProfileIdInput {
  merchant_profile_id: string;
}

export interface GetActiveProSubscriptionsInput {
  limit?: number;
  offset?: number;
}

export class MerchantProSubscriptionService {
  constructor(private pool: SubscriptionDatabase) {}

  private dateOnly(date: Date): string { return date.toISOString().slice(0, 10); }
  private normalize(row: MerchantProSubscription): MerchantProSubscription {
    const utcDate = (value: Date | null) => value === null ? null : new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    return { ...row, subscription_start: utcDate(row.subscription_start)!, subscription_end: utcDate(row.subscription_end) };
  }

  async activateSubscription(merchantId: string, period: ProPeriod, actorId: string, now = new Date()): Promise<MerchantProSubscription> {
    if (!['MONTHLY', 'ANNUAL'].includes(period) || !actorId || !Number.isFinite(now.getTime())) throw new Error('INVALID_SUBSCRIPTION');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const { rows: profiles } = await client.query(
        'SELECT id,country FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [merchantId]);
      if (!profiles.length) throw new Error('MERCHANT_NOT_FOUND');
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      await client.query(
        "UPDATE konektag.merchant_pro_subscriptions SET status='EXPIRED', updated_at=now() WHERE merchant_profile_id=$1 AND status='ACTIVE' AND subscription_end <= $2::date",
        [merchantId, this.dateOnly(start)]);
      const { rows: active } = await client.query(
        "SELECT id FROM konektag.merchant_pro_subscriptions WHERE merchant_profile_id=$1 AND status='ACTIVE' LIMIT 1", [merchantId]);
      if (active.length) throw new Error('SUBSCRIPTION_ALREADY_ACTIVE');
      const price = proPrice(period);
      const { rows } = await client.query<MerchantProSubscription>(
        `INSERT INTO konektag.merchant_pro_subscriptions
          (merchant_profile_id,subscription_start,subscription_end,subscription_type,status,
           auto_renew,first_activation,price_minor,currency,activated_by,activated_at)
         VALUES ($1,$2,$3,$4,'ACTIVE',false,
           NOT EXISTS (SELECT 1 FROM konektag.merchant_pro_subscriptions WHERE merchant_profile_id=$1),
           $5,$6,$7,$8) RETURNING *`,
        [merchantId, this.dateOnly(start), this.dateOnly(addProPeriod(start, period)), period, price.amountMinor, price.currency, actorId, now]);
      await client.query('COMMIT');
      return this.normalize(rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async cancelAtEnd(merchantId: string, now = new Date()): Promise<MerchantProSubscription> {
    const { rows } = await this.pool.query<MerchantProSubscription>(
      `UPDATE konektag.merchant_pro_subscriptions SET cancelled_at=COALESCE(cancelled_at,$2),updated_at=now()
       WHERE merchant_profile_id=$1 AND status='ACTIVE' AND subscription_end > $2::date RETURNING *`, [merchantId, now]);
    if (!rows.length) throw new Error('NO_SUBSCRIPTION_FOUND');
    return this.normalize(rows[0]);
  }

  async applyPaidRenewal(orderId: string, client: PoolClient): Promise<boolean> {
    const { rows: [intent] } = await client.query<{
      id: string; subscription_id: string | null; subscription_type: ProPeriod; price_minor: number;
      currency: string; status: string; merchant_profile_id: string; initial_approved_by: string | null;
    }>(`SELECT * FROM konektag.merchant_pro_renewal_intents WHERE payment_order_id=$1 FOR UPDATE`, [orderId]);
    if (!intent || intent.status === 'APPLIED') return false;
    if (intent.status !== 'PENDING') throw new Error('INVALID_RENEWAL_INTENT');
    const { rows: [order] } = await client.query<{ state: string; amount_unit: string; currency: string; total_amount: number; business_purpose: string }>(
      'SELECT state,amount_unit,currency,total_amount,business_purpose FROM konektag.api_payment_orders WHERE id=$1', [orderId]);
    if (!order || order.state !== 'paid' || order.amount_unit !== 'MINOR' || order.currency !== intent.currency
      || Number(order.total_amount) !== Number(intent.price_minor) || order.business_purpose !== 'pro_subscription_renewal') {
      throw new Error('RENEWAL_PAYMENT_NOT_CONFIRMED');
    }
    if (!intent.subscription_id) {
      if (!intent.initial_approved_by) throw new Error('INITIAL_PAYMENT_NOT_APPROVED');
      const { rows: profiles } = await client.query(
        'SELECT id FROM konektag.merchant_profiles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
        [intent.merchant_profile_id]);
      if (!profiles.length) throw new Error('MERCHANT_NOT_FOUND');
      const { rows: existing } = await client.query(
        'SELECT id FROM konektag.merchant_pro_subscriptions WHERE merchant_profile_id=$1 LIMIT 1',
        [intent.merchant_profile_id]);
      if (existing.length) throw new Error('INITIAL_SUBSCRIPTION_ALREADY_EXISTS');
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      await client.query(`INSERT INTO konektag.merchant_pro_subscriptions
        (merchant_profile_id,subscription_start,subscription_end,subscription_type,status,
         auto_renew,first_activation,price_minor,currency,activated_by,activated_at,last_payment_order_id)
        VALUES ($1,$2,$3,$4,'ACTIVE',false,true,$5,$6,$7,now(),$8)`,
        [intent.merchant_profile_id, this.dateOnly(start), this.dateOnly(addProPeriod(start, intent.subscription_type)),
          intent.subscription_type, intent.price_minor, intent.currency, intent.initial_approved_by, orderId]);
      await client.query(`UPDATE konektag.merchant_pro_renewal_intents SET status='APPLIED',applied_at=now() WHERE id=$1`, [intent.id]);
      return true;
    }
    const { rows: [subscription] } = await client.query<MerchantProSubscription>(
      'SELECT * FROM konektag.merchant_pro_subscriptions WHERE id=$1 AND merchant_profile_id=$2 FOR UPDATE',
      [intent.subscription_id, intent.merchant_profile_id]);
    if (!subscription) throw new Error('SUBSCRIPTION_NOT_FOUND');
    const today = new Date();
    const paidEnd = subscription.subscription_end ? this.normalize(subscription).subscription_end! : today;
    const base = paidEnd > today ? paidEnd : today;
    const end = addProPeriod(base, intent.subscription_type);
    await client.query(`UPDATE konektag.merchant_pro_subscriptions SET subscription_end=$2,subscription_type=$3,
      status='ACTIVE',price_minor=$4,currency=$5,cancelled_at=NULL,renewal_requested=false,renewal_type=NULL,
      last_payment_order_id=$6,last_renewed_at=now(),updated_at=now() WHERE id=$1`,
      [subscription.id, this.dateOnly(end), intent.subscription_type, intent.price_minor, intent.currency, orderId]);
    await client.query(`UPDATE konektag.merchant_pro_renewal_intents SET status='APPLIED',applied_at=now() WHERE id=$1`, [intent.id]);
    return true;
  }

  async resolveSubscription(merchantId: string, occurredAt = new Date()): Promise<{ state: SubscriptionState; subscription: MerchantProSubscription | null }> {
    if (!Number.isFinite(occurredAt.getTime())) throw new Error('INVALID_SUBSCRIPTION_DATE');
    const { rows: rawRows } = await this.pool.query<MerchantProSubscription>(
      `SELECT * FROM konektag.merchant_pro_subscriptions WHERE merchant_profile_id = $1
       ORDER BY subscription_start DESC, created_at DESC, id DESC`, [merchantId]);
    const rows = rawRows.map(row => this.normalize(row));
    const stateOf = (row: MerchantProSubscription): SubscriptionState => {
      if (!['MONTHLY', 'ANNUAL'].includes(row.subscription_type)) return 'INACTIVE';
      if (row.status === 'CANCELLED') return 'CANCELLED';
      if (row.status === 'INACTIVE') return 'INACTIVE';
      if (row.status === 'EXPIRED') return 'EXPIRED';
      if (row.status !== 'ACTIVE') return 'INACTIVE';
      const start = new Date(row.subscription_start).getTime();
      const end = row.subscription_end === null ? Infinity : new Date(row.subscription_end).getTime();
      if (!Number.isFinite(start) || Number.isNaN(end) || end <= start) return 'INACTIVE';
      if (end <= occurredAt.getTime()) return 'EXPIRED';
      if (start > occurredAt.getTime()) return 'SCHEDULED';
      return 'ACTIVE';
    };
    const subscription = rows.find(row => stateOf(row) === 'ACTIVE') ?? rows[0] ?? null;
    return { state: subscription ? stateOf(subscription) : 'ABSENT', subscription };
  }

  async getActiveSubscription(merchantId: string, occurredAt = new Date()): Promise<MerchantProSubscription | null> {
    const result = await this.resolveSubscription(merchantId, occurredAt);
    return result.state === 'ACTIVE' ? result.subscription : null;
  }

  private async connect(): Promise<PoolClient> {
    if (!this.pool.connect) throw new Error('Subscription writes require a pool');
    return this.pool.connect();
  }

  async createSubscription(input: CreateMerchantProSubscriptionInput): Promise<MerchantProSubscription> {
    if (!['MONTHLY', 'ANNUAL'].includes(input.subscription_type) ||
        !Number.isFinite(new Date(input.subscription_start).getTime()) ||
        (input.subscription_end !== null && (!Number.isFinite(new Date(input.subscription_end).getTime()) ||
          new Date(input.subscription_end) <= new Date(input.subscription_start)))) throw new Error('INVALID_SUBSCRIPTION');
    const client = await this.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO konektag.merchant_pro_subscriptions (
          merchant_profile_id,
          subscription_start,
          subscription_end,
          subscription_type,
          status,
          auto_renew,
          first_activation
        ) VALUES ($1, $2, $3, $4, $7, $5, $6) RETURNING *`,
        [
          input.merchant_profile_id,
          input.subscription_start,
          input.subscription_end,
          input.subscription_type,
          input.auto_renew || false,
          input.first_activation ?? true,
          'ACTIVE'
        ]
      );

      if (!result.rows[0]) throw new Error('Subscription not found');
      await client.query('COMMIT');
      return this.normalize(result.rows[0] as MerchantProSubscription);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getSubscriptionById(id: string): Promise<MerchantProSubscription | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM konektag.merchant_pro_subscriptions WHERE id = $1',
      [id]
    );

    return rows[0] ? this.normalize(rows[0]) : null;
  }

  async getSubscriptionByProfileId(input: GetProSubscriptionByProfileIdInput): Promise<MerchantProSubscription | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM konektag.merchant_pro_subscriptions WHERE merchant_profile_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [input.merchant_profile_id]
    );

    return rows[0] ? this.normalize(rows[0]) : null;
  }

  async getActiveSubscriptions(input: GetActiveProSubscriptionsInput): Promise<{
    subscriptions: MerchantProSubscription[];
    total: number;
  }> {
    const limit = Number.isInteger(input.limit) && input.limit! > 0 ? Math.min(input.limit!, 200) : 20;
    const offset = Number.isInteger(input.offset) && input.offset! >= 0 ? input.offset! : 0;
    const at = new Date();

    // Get the subscriptions
    const { rows } = await this.pool.query(
      `SELECT * FROM konektag.merchant_pro_subscriptions
       WHERE status = $3 AND subscription_start <= $4
         AND (subscription_end IS NULL OR subscription_end > $4)
         AND subscription_type IN ($5, $6)
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, 'ACTIVE', at, 'MONTHLY', 'ANNUAL']
    );

    // Get total count
    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM konektag.merchant_pro_subscriptions WHERE status = $1
       AND subscription_start <= $2 AND (subscription_end IS NULL OR subscription_end > $2)
       AND subscription_type IN ($3, $4)`, ['ACTIVE', at, 'MONTHLY', 'ANNUAL']
    );

    return {
      subscriptions: (rows as MerchantProSubscription[]).map(row => this.normalize(row)),
      total: parseInt(countResult.rows[0].total)
    };
  }

  async updateSubscription(input: UpdateMerchantProSubscriptionInput): Promise<MerchantProSubscription> {
    if (input.status !== undefined && !['ACTIVE', 'INACTIVE', 'EXPIRED', 'CANCELLED'].includes(input.status)) throw new Error('INVALID_SUBSCRIPTION');
    if (input.subscription_end !== undefined && input.subscription_end !== null && !Number.isFinite(new Date(input.subscription_end).getTime())) throw new Error('INVALID_SUBSCRIPTION_DATE');
    const client = await this.connect();

    try {
      await client.query('BEGIN');

      // Build dynamic query based on input fields
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (input.status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        values.push(input.status);
      }

      if (input.subscription_end !== undefined) {
        updates.push(`subscription_end = $${paramIndex++}`);
        values.push(input.subscription_end);
      }

      if (input.renewal_requested !== undefined) {
        updates.push(`renewal_requested = $${paramIndex++}`);
        values.push(input.renewal_requested);
      }

      if (input.renewal_type !== undefined) {
        updates.push(`renewal_type = $${paramIndex++}`);
        values.push(input.renewal_type);
      }

      if (input.auto_renew !== undefined) {
        updates.push(`auto_renew = $${paramIndex++}`);
        values.push(input.auto_renew);
      }

      updates.push(`updated_at = NOW()`);

      const query = `
        UPDATE konektag.merchant_pro_subscriptions
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      values.push(input.id);

      const result = await client.query(query, values);

      if (!result.rows[0]) throw new Error('Subscription not found');
      await client.query('COMMIT');
      return this.normalize(result.rows[0] as MerchantProSubscription);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateSubscriptionsByProfile(merchantId: string): Promise<MerchantProSubscription[]> {
    const { rows } = await this.pool.query<MerchantProSubscription>(
      'UPDATE konektag.merchant_pro_subscriptions SET status = $2, updated_at = NOW() WHERE merchant_profile_id = $1 AND status = $3 RETURNING *',
      [merchantId, 'INACTIVE', 'ACTIVE']);
    return rows;
  }

  async deactivateSubscription(id: string): Promise<MerchantProSubscription> {
    const result = await this.pool.query(
      'UPDATE konektag.merchant_pro_subscriptions SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id, 'EXPIRED']
    );

    return result.rows[0] as MerchantProSubscription;
  }

  async calculateAnnualPrice(monthsRemaining: number, monthlyPrice: number): Promise<number> {
    return monthsRemaining * monthlyPrice * 0.95; // 5% discount
  }

  /**
   * Calculate prorated annual price based on subscription start date for a full year
   */
  async calculateProratedAnnualPrice(subscriptionStart: Date, monthlyPrice: number): Promise<{ amount: number; available: boolean }> {
    const startDate = new Date(subscriptionStart);
    const year = startDate.getFullYear();
    
    // Calculate how many days are left in the current month
    const daysInMonth = new Date(year, startDate.getMonth() + 1, 0).getDate();
    const daysRemainingInMonth = daysInMonth - startDate.getDate() + 1;
    
    // Calculate complete months from next month until end of year
    const monthsCompleted = 11 - startDate.getMonth(); // from current month to December
    
    // Add the fraction of the current month
    const fractionOfCurrentMonth = daysRemainingInMonth / daysInMonth;
    
    // Total months for annual calculation (with prorata)
    let totalMonths = monthsCompleted + fractionOfCurrentMonth;
    
    // Ensure we don't count more than 12 months
    if (totalMonths > 12) {
      totalMonths = 12;
    }

    // Check if the subscription would be available (> 1 month equivalent)
    const isAvailable = totalMonths > 1;

    // Calculate final amount with 5% discount if available
    let amount = 0;
    if (isAvailable) {
      const baseAmount = totalMonths * monthlyPrice;
      amount = Math.round(baseAmount * 0.95); // Apply 5% discount and round to nearest integer
    }
    
    return { amount, available: isAvailable };
  }

  /**
   * Calculate prorated price for a subscription that starts today
   */
  async calculateProratedMonthlyPrice(subscriptionStart: Date, monthlyPrice: number): Promise<number> {
    const startDate = new Date(subscriptionStart);
    const year = startDate.getFullYear();
    
    // Calculate how many days are left in the current month
    const daysInMonth = new Date(year, startDate.getMonth() + 1, 0).getDate();
    const daysRemainingInMonth = daysInMonth - startDate.getDate() + 1;
    
    // Calculate prorated monthly price
    const fractionOfCurrentMonth = daysRemainingInMonth / daysInMonth;
    const baseAmount = monthlyPrice * fractionOfCurrentMonth;
    
    return Math.round(baseAmount); // Round to nearest integer
  }
}
