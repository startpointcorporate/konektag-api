import crypto from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';
import { loyaltyService } from './loyalty-service.ts';

function generateCode(userId: string): string {
  const hash = crypto.createHash('sha256').update(userId + Date.now()).digest('hex');
  return hash.slice(0, 8).toUpperCase();
}

export const referralService = {
  async getOrCreateCode(userId: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT code FROM konektag.referral_codes WHERE user_id = $1`,
      [userId],
    );
    if (rows[0]) return rows[0].code;

    let code: string;
    let attempts = 0;
    while (attempts < 10) {
      code = generateCode(userId);
      const { rows: existing } = await pool.query(
        `SELECT id FROM konektag.referral_codes WHERE code = $1`,
        [code],
      );
      if (!existing.length) {
        await pool.query(
          `INSERT INTO konektag.referral_codes (user_id, code) VALUES ($1, $2)`,
          [userId, code],
        );
        return code;
      }
      attempts++;
    }
    throw new Error('Could not generate unique referral code');
  },

  async applyCode(code: string, referredUserId: string): Promise<void> {
    const { rows: [referralCode] } = await pool.query(
      `SELECT id, user_id FROM konektag.referral_codes WHERE code = $1`,
      [code],
    );
    if (!referralCode) throw new Error('INVALID_CODE');
    if (referralCode.user_id === referredUserId) throw new Error('SELF_REFERRAL');

    const { rows: [existing] } = await pool.query(
      `SELECT id FROM konektag.referral_redemptions WHERE referred_user_id = $1`,
      [referredUserId],
    );
    if (existing) throw new Error('ALREADY_REDEEMED');

    const rewardPoints = 50;
    try {
      await pool.query(
        `INSERT INTO konektag.referral_redemptions (code_id, referred_user_id, reward_status, reward_points)
         VALUES ($1, $2, 'pending', $3)`,
        [referralCode.id, referredUserId, rewardPoints],
      );
    } catch (error: any) {
      if (error?.code === '23505') throw new Error('ALREADY_REDEEMED');
      throw error;
    }

    await loyaltyService.earnPoints(referredUserId, 'signup', undefined, `referral-signup:${referralCode.id}:${referredUserId}`);
  },

  async confirmReferral(referredUserId: string): Promise<void> {
    const { rows: [redemption] } = await pool.query(
      `SELECT rc.user_id AS referrer_id, rr.id, rr.reward_points
       FROM konektag.referral_redemptions rr
       JOIN konektag.referral_codes rc ON rc.id = rr.code_id
       WHERE rr.referred_user_id = $1 AND rr.reward_status = 'pending'`,
      [referredUserId],
    );
    if (!redemption) return;

    await pool.query(
      `UPDATE konektag.referral_redemptions SET reward_status = 'rewarded' WHERE id = $1`,
      [redemption.id],
    );

    await loyaltyService.earnPoints(redemption.referrer_id, 'referral', undefined, `referral-reward:${redemption.id}`);
  },

  async getStats(userId: string) {
    const code = await this.getOrCreateCode(userId);

    const { rows: [codeRow] } = await pool.query(
      `SELECT id FROM konektag.referral_codes WHERE user_id = $1`,
      [userId],
    );

    let totalReferrals = 0;
    let rewardedReferrals = 0;
    let pendingReferrals = 0;
    let totalPointsEarned = 0;

    if (codeRow) {
      const { rows: stats } = await pool.query(
        `SELECT reward_status, reward_points FROM konektag.referral_redemptions WHERE code_id = $1`,
        [codeRow.id],
      );
      totalReferrals = stats.length;
      for (const r of stats) {
        if (r.reward_status === 'rewarded') {
          rewardedReferrals++;
          totalPointsEarned += r.reward_points;
        } else if (r.reward_status === 'pending') {
          pendingReferrals++;
        }
      }
    }

    return {
      code,
      totalReferrals,
      rewardedReferrals,
      pendingReferrals,
      totalPointsEarned,
      shareUrl: `https://www.konektag.eu?ref=${code}`,
    };
  },
};
