import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { accountingService } from './accounting-service.ts';
import { exchangeRateService } from './exchange-rate-service.ts';
import pool from '../../infrastructure/database/pool.ts';

export type ActivationMetricType = 'Deposit' | 'KSend' | 'QrPaymentReceived' | 'MerchantPayment';
export type ActivationSourceType = 'recharge' | 'k_send' | 'qr_personal' | 'merchant_payment';

type Queryable = Pick<PoolClient, 'query'>;

export class ActivationChallengeError extends Error {}

export type RecordActivationActivityInput = {
  userId: string;
  financialTransactionId?: string;
  sourceType: ActivationSourceType;
  sourceId: string;
  metricType: ActivationMetricType;
  amount: number;
  currency: string;
  countryCode?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
};

function countryCode(value?: string | null): string | null {
  const normalized = value?.trim().toUpperCase() || '';
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ActivationChallengeError('Activation activity amount must be a positive integer');
  }
}

function asNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export const activationChallengeService = {
  async startCurrentChallenge(userId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: users } = await client.query<{ country: string | null }>(
        `SELECT country FROM konektag.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [userId],
      );
      if (!users[0]) throw new ActivationChallengeError('User not found');
      const userCountry = countryCode(users[0].country);
      const { rows: campaigns } = await client.query<{
        id: string; internal_name: string; public_title: string; public_description: string; baseline: string;
        starts_at: string; ends_at: string; time_zone: string;
        currency: string; max_bonus_amount: number; eligible_country_codes: string[];
      }>(
        `SELECT id, internal_name, public_title, public_description, baseline, starts_at, ends_at, time_zone,
                 currency, max_bonus_amount, eligible_country_codes

         FROM konektag.activation_campaigns
WHERE status = 'active' AND deleted_at IS NULL AND starts_at <= now()
            AND (cardinality(eligible_country_codes) = 0 OR $1 = ANY(eligible_country_codes))
         LIMIT 1 FOR UPDATE`,
        [userCountry],
      );
      const campaign = campaigns[0];
      if (!campaign) throw new ActivationChallengeError('No eligible activation campaign is active');

      const snapshot = {
        id: campaign.id,
        internalName: campaign.internal_name,
        publicTitle: campaign.public_title,
        publicDescription: campaign.public_description,
        baseline: campaign.baseline,
        startsAt: campaign.starts_at,
        endsAt: campaign.ends_at,
        timeZone: campaign.time_zone,
        currency: campaign.currency,
        maxBonusAmount: asNumber(campaign.max_bonus_amount),
      };
      const { rows } = await client.query(
        `INSERT INTO konektag.activation_challenges
           (campaign_id, user_id, expires_at, campaign_snapshot)
         VALUES ($1, $2, 'infinity'::timestamptz, $3)
         ON CONFLICT (campaign_id, user_id) DO UPDATE SET updated_at = now()
         RETURNING id, status, started_at, expires_at, total_bonus_earned`,
        [campaign.id, userId, JSON.stringify(snapshot)],
      );
      await client.query(
        `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload)
         VALUES ($1, $2, 'ActivationChallengeStarted', $3)`,
        [userId, crypto.randomUUID(), JSON.stringify({ campaignId: campaign.id })],
      );
      await client.query('COMMIT');
      return { ...rows[0], campaign: snapshot };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async recordActivity(input: RecordActivationActivityInput): Promise<{ recorded: boolean; bonusesCredited: number }> {
    assertAmount(input.amount);
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new ActivationChallengeError('Activation activity currency must be ISO 4217');
    }
    const conversion = await exchangeRateService.convert(input.amount, input.currency, 'EUR');
    if (!conversion) throw new ActivationChallengeError(`No EUR conversion is available for ${input.currency}`);

await this.currentChallenge(input.userId);
const client = await pool.connect();
let bonusIds: string[] = [];
    try {
      await client.query('BEGIN');
      const { rows: activities } = await client.query<{ id: string }>(
        `INSERT INTO konektag.activation_activity_events
           (user_id, financial_transaction_id, source_type, source_id, metric_type, source_amount,
            source_currency, campaign_amount, exchange_rate, country_code, occurred_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (source_type, source_id) DO NOTHING
         RETURNING id`,
        [
          input.userId, input.financialTransactionId ?? null, input.sourceType, input.sourceId,
          input.metricType, input.amount, input.currency, conversion.value, conversion.rate,
          countryCode(input.countryCode), input.occurredAt ?? new Date(), JSON.stringify(input.metadata ?? {}),
        ],
      );
      const activity = activities[0];
      if (!activity) {
        await client.query('COMMIT');
        return { recorded: false, bonusesCredited: await this.creditPendingBonusesForUser(input.userId) };
      }

      const { rows: challenges } = await client.query<{ id: string; campaign_id: string }>(
        `SELECT ch.id, ch.campaign_id
         FROM konektag.activation_challenges ch
         JOIN konektag.activation_campaigns c ON c.id = ch.campaign_id AND c.deleted_at IS NULL
         WHERE ch.user_id = $1 AND ch.status = 'active'
           AND c.status = 'active' AND c.starts_at <= now()
         FOR UPDATE OF ch`,
        [input.userId],
      );
      const challenge = challenges[0];
      if (!challenge) {
        await client.query('COMMIT');
        return { recorded: true, bonusesCredited: 0 };
      }

      const { rows: milestones } = await client.query<{
        id: string; target_amount: number; bonus_amount: number; requires_verified_account: boolean;
      }>(
        `SELECT id, target_amount, bonus_amount, requires_verified_account
         FROM konektag.activation_milestones
         WHERE campaign_id = $1 AND metric_type = $2 AND is_enabled
           AND (cardinality(eligible_country_codes) = 0 OR $3 = ANY(eligible_country_codes))
         ORDER BY sort_order
         FOR UPDATE`,
        [challenge.campaign_id, input.metricType, countryCode(input.countryCode)],
      );

      for (const milestone of milestones) {
        if (milestone.requires_verified_account && !await this.hasVerifiedKyc(client, input.userId)) continue;
        const { rows: progresses } = await client.query<{ id: string; accumulated_amount: string | number; reached_at: string | null }>(
          `INSERT INTO konektag.activation_milestone_progress (challenge_id, milestone_id)
           VALUES ($1, $2)
           ON CONFLICT (challenge_id, milestone_id) DO UPDATE SET updated_at = now()
           RETURNING id, accumulated_amount, reached_at`,
          [challenge.id, milestone.id],
        );
        const progress = progresses[0];
        if (!progress) throw new ActivationChallengeError('Unable to create milestone progress');
        const contributed = await client.query(
          `INSERT INTO konektag.activation_milestone_contributions (milestone_progress_id, activity_event_id, amount)
           VALUES ($1, $2, $3)
           ON CONFLICT (milestone_progress_id, activity_event_id) DO NOTHING
           RETURNING id`,
          [progress.id, activity.id, conversion.value],
        );
        if (!contributed.rows[0]) continue;

        const previousAmount = asNumber(progress.accumulated_amount);
        const nextAmount = previousAmount + conversion.value;
        const reached = !progress.reached_at && nextAmount >= asNumber(milestone.target_amount);
        await client.query(
          `UPDATE konektag.activation_milestone_progress
           SET accumulated_amount = $1, reached_at = CASE WHEN $2 THEN now() ELSE reached_at END,
               updated_at = now(), version = version + 1
           WHERE id = $3`,
          [nextAmount, reached, progress.id],
        );
        if (!reached) continue;
        const { rows: bonuses } = await client.query<{ id: string }>(
          `INSERT INTO konektag.activation_bonuses (challenge_id, milestone_id, user_id, amount)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (challenge_id, milestone_id) DO NOTHING
           RETURNING id`,
          [challenge.id, milestone.id, input.userId, milestone.bonus_amount],
        );
        if (bonuses[0]) {
          bonusIds.push(bonuses[0].id);
          await client.query(
            `INSERT INTO konektag.outbox_events
              (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
             VALUES ($1, 'ActivationBonus', $2, 'ActivationBonusEarned', 1, $3)`,
            [crypto.randomUUID(), bonuses[0].id, JSON.stringify({ bonusId: bonuses[0].id, challengeId: challenge.id })],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    let bonusesCredited = 0;
    for (const bonusId of bonusIds) {
      if (await this.creditEarnedBonus(bonusId)) bonusesCredited++;
    }
    return { recorded: true, bonusesCredited };
  },

  async creditPendingBonusesForUser(userId: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM konektag.activation_bonuses
       WHERE user_id = $1 AND status = 'earned'
       ORDER BY earned_at`,
      [userId],
    );
    let credited = 0;
    for (const bonus of rows) {
      if (await this.creditEarnedBonus(bonus.id)) credited++;
    }
    return credited;
  },

  async creditEarnedBonus(bonusId: string): Promise<boolean> {
    const { rows } = await pool.query<{
      id: string; challenge_id: string; milestone_id: string; user_id: string; amount: number; status: string;
      party_id: string | null;
    }>(
      `SELECT b.id, b.challenge_id, b.milestone_id, b.user_id, b.amount, b.status, p.id AS party_id
       FROM konektag.activation_bonuses b
       JOIN konektag.users u ON u.id = b.user_id AND u.deleted_at IS NULL
       LEFT JOIN konektag.parties p ON p.keycloak_id = u.keycloak_id AND p.is_active = true
       WHERE b.id = $1`,
      [bonusId],
    );
    const bonus = rows[0];
    if (!bonus || bonus.status === 'credited') return false;
    if (!bonus.party_id) throw new ActivationChallengeError('Activation bonus recipient has no active financial party');

    const result = await accountingService.postTransaction({
      idempotencyKey: `activation-bonus:${bonus.challenge_id}:${bonus.milestone_id}`,
      transactionType: 'activation_bonus',
      businessReference: bonus.id,
      currency: 'EUR',
      description: `Activation Challenge bonus ${bonus.id}`,
      entries: [
        { accountCode: '4200', side: 'debit', amount: asNumber(bonus.amount), description: 'Activation Challenge bonus expense' },
        { accountCode: '1000', partyId: bonus.party_id, side: 'credit', amount: asNumber(bonus.amount), description: 'Activation Challenge bonus wallet credit' },
      ],
      metadata: { activationBonusId: bonus.id, challengeId: bonus.challenge_id, milestoneId: bonus.milestone_id },
    });
    if (!result.success) throw new ActivationChallengeError(result.error || 'Activation bonus accounting failed');

    const { rows: updated } = await pool.query(
      `UPDATE konektag.activation_bonuses
       SET status = 'credited', financial_transaction_id = $1, credited_at = now(), updated_at = now(), version = version + 1
       WHERE id = $2 AND status = 'earned'
       RETURNING id`,
      [result.financialTransactionId, bonus.id],
    );
    if (!updated[0]) return false;
    await pool.query(
      `UPDATE konektag.activation_challenges
       SET total_bonus_earned = total_bonus_earned + $1, updated_at = now(), version = version + 1
       WHERE id = $2`,
      [bonus.amount, bonus.challenge_id],
    );
    return true;
  },

  async hasVerifiedKyc(client: Queryable, userId: string): Promise<boolean> {
    const { rows } = await client.query<{ verified: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM konektag.kyc_orders
         WHERE user_id = $1 AND status = 'verified' AND deleted_at IS NULL
       ) AS verified`,
      [userId],
    );
    return Boolean(rows[0]?.verified);
  },

  async currentChallenge(userId: string) {
    const query = `SELECT ch.id, ch.status, ch.started_at, ch.expires_at, ch.total_bonus_earned, ch.campaign_snapshot,
            c.id AS campaign_id, c.public_title, c.public_description, c.baseline, c.max_bonus_amount,
            c.currency, c.ends_at, c.eligible_country_codes,
            COALESCE(json_agg(json_build_object(
              'id', m.id, 'metricType', m.metric_type, 'targetAmount', m.target_amount,
              'bonusAmount', m.bonus_amount, 'title', m.public_title, 'description', m.public_description,
              'ctaType', m.cta_type, 'eligibleCountryCodes', m.eligible_country_codes,
              'accumulatedAmount', COALESCE(p.accumulated_amount, 0), 'reachedAt', p.reached_at,
              'bonusStatus', b.status
            ) ORDER BY m.sort_order) FILTER (WHERE m.id IS NOT NULL), '[]') AS milestones
       FROM konektag.activation_challenges ch
       JOIN konektag.activation_campaigns c ON c.id = ch.campaign_id AND c.deleted_at IS NULL
       LEFT JOIN konektag.activation_milestones m ON m.campaign_id = c.id AND m.is_enabled
       LEFT JOIN konektag.activation_milestone_progress p ON p.challenge_id = ch.id AND p.milestone_id = m.id
       LEFT JOIN konektag.activation_bonuses b ON b.challenge_id = ch.id AND b.milestone_id = m.id
       WHERE ch.user_id = $1
       GROUP BY ch.id, c.id
       ORDER BY ch.created_at DESC
       LIMIT 1`;
    const { rows } = await pool.query(query, [userId]);
    const existing = rows[0] ?? null;
    if (!existing) {
      await this.startCurrentChallenge(userId);
      const { rows: rows2 } = await pool.query(query, [userId]);
      return rows2[0] ?? null;
    }
    return existing;
  },

};
