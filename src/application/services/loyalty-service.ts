import pool from '../../infrastructure/database/pool.ts';

export const LOYALTY_ACTIONS = ['transfer', 'qr_payment', 'review', 'referral', 'signup'] as const;
export type LoyaltyAction = typeof LOYALTY_ACTIONS[number];

const LEVEL_ORDER = ['bronze', 'silver', 'gold', 'platinum'] as const;

async function getConfig(key: string): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `SELECT value FROM konektag.configurations WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? {};
}

export const loyaltyService = {
  async earnPoints(userId: string, action: LoyaltyAction, amount?: number, reference?: string) {
    const actionPoints = await getConfig('LOYALTY_POINTS_PER_ACTION');
    let points = actionPoints[action] ?? 0;

    if (amount && amount > 0) {
      const amountConfig = await getConfig('LOYALTY_POINTS_PER_AMOUNT');
      const per = amountConfig.per ?? 1000;
      const pts = amountConfig.points ?? 1;
      points += Math.floor(amount / per) * pts;
    }

    if (points <= 0) return;

    if (!reference) throw new Error('LOYALTY_REFERENCE_REQUIRED');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [inserted] } = await client.query(
        `INSERT INTO konektag.loyalty_transactions (user_id, points, reason, reference)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, reason, reference) DO NOTHING
         RETURNING id`,
        [userId, points, action, reference],
      );
      if (!inserted) {
        await client.query('COMMIT');
        return;
      }
      const { rows: [existing] } = await client.query(
        `SELECT points FROM konektag.loyalty_points WHERE user_id = $1 FOR UPDATE`, [userId]);
      const newPoints = Number(existing?.points ?? 0) + points;
      const newLevel = await this.calculateLevel(newPoints);
      if (existing) {
        await client.query(
          `UPDATE konektag.loyalty_points SET points = $1, level = $2, updated_at = now() WHERE user_id = $3`,
          [newPoints, newLevel, userId]);
      } else {
        await client.query(
          `INSERT INTO konektag.loyalty_points (user_id, points, level) VALUES ($1, $2, $3)`,
          [userId, newPoints, newLevel]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async calculateLevel(totalPoints: number): Promise<string> {
    const thresholds = await getConfig('LOYALTY_LEVEL_THRESHOLDS');
    let currentLevel: string = LEVEL_ORDER[0];
    for (const level of LEVEL_ORDER) {
      const min = thresholds[level] ?? 0;
      if (totalPoints >= min) {
        currentLevel = level;
      }
    }
    return currentLevel;
  },

  async getLevelName(level: string): Promise<string> {
    const names = await getConfig('LOYALTY_LEVEL_NAMES');
    return String(names[level] ?? level);
  },

  async getStats(userId: string) {
    const { rows: [loyalty] } = await pool.query(
      `SELECT points, level FROM konektag.loyalty_points WHERE user_id = $1`,
      [userId],
    );
    const { rows: [sum] } = await pool.query(
      `SELECT COALESCE(SUM(points), 0)::int AS total FROM konektag.loyalty_transactions WHERE user_id = $1 AND points > 0`,
      [userId],
    );
    const levelName = await this.getLevelName(loyalty?.level ?? 'bronze');
    return {
      points: loyalty?.points ?? 0,
      level: loyalty?.level ?? 'bronze',
      levelName,
      totalEarned: sum?.total ?? 0,
    };
  },
};
