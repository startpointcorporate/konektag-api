import { REVIEW_VISIBLE_SQL, VERIFIED_CUSTOMER_SQL } from './review-community-service.ts';
import pool from '../../infrastructure/database/pool.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';

export interface Review {
  id: string;
  userId: string;
  merchantId: string;
  rating: number;
  comment: string | null;
  userName?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PaginatedReviews {
  reviews: Review[];
  total: number;
  averageRating: number;
}

export const reviewService = {
  async createReview(userId: string, merchantSlug: string, rating: number, comment?: string): Promise<Review> {
    const { rows: [mp] } = await pool.query(
      `SELECT id, user_id, business_name FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`,
      [merchantSlug],
    );
    if (!mp) throw new Error('Établissement introuvable');

    const merchantId = mp.id;
    if (mp.user_id === userId) throw new Error('Vous ne pouvez pas noter votre propre établissement');
    const { rows: [member] } = await pool.query(
      `SELECT 1 FROM konektag.merchant_memberships WHERE merchant_profile_id=$1 AND user_id=$2 AND status='active' AND removed_at IS NULL LIMIT 1`,
      [merchantId, userId],
    );
    if (member) throw new Error('Vous ne pouvez pas noter un établissement que vous gérez');

    // Vérifier si l'utilisateur a déjà noté cet établissement
    const { rows: [existing] } = await pool.query(
      `SELECT id FROM konektag.reviews WHERE user_id = $1 AND merchant_id = $2 AND deleted_at IS NULL`,
      [userId, merchantId],
    );
    if (existing) throw new Error('Vous avez déjà donné votre avis sur cet établissement');

    const correlationId = getCorrelationId();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM konektag.merchant_profiles WHERE id=$1 FOR UPDATE',[merchantId]);

      const { rows: [review] } = await client.query(
        `INSERT INTO konektag.reviews (user_id, merchant_id, rating, comment)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [userId, merchantId, rating, comment ?? null],
      );

      // Mettre à jour la moyenne rating sur merchant_profiles
      await client.query(
        `UPDATE konektag.merchant_profiles SET
           rating = (SELECT ROUND(AVG(r.rating)::numeric, 1) FROM konektag.reviews r WHERE r.merchant_id = $1 AND r.deleted_at IS NULL AND ${REVIEW_VISIBLE_SQL}),
           version = version + 1
         WHERE id = $1`,
        [merchantId],
      );

      // Notifier le propriétaire du commerce
      if (mp.user_id && mp.user_id !== userId) {
        await client.query(
          `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
           VALUES ($1, 'MerchantProfile', $2, 'NewReview', 1, $3)`,
          [correlationId, merchantId, JSON.stringify({
            merchantId,
            userId,
            rating,
            comment: comment ?? null,
            businessName: mp.business_name,
            reviewId: review.id,
          })],
        );
      }

      // Audit log
      await client.query(
        `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload)
         VALUES ($1, $2, 'REVIEW_CREATED', $3)`,
        [userId, correlationId, { reviewId: review.id, merchantId, rating }],
      );

      // Attribution de points de fidélité
      try {
        const { rows: [loyalty] } = await client.query(
          `SELECT points, level, version FROM konektag.loyalty_points WHERE user_id = $1`,
          [userId],
        );
        const reviewPoints = 5;
        if (loyalty) {
          await client.query(
            `UPDATE konektag.loyalty_points SET points = points + $1, updated_at = now() WHERE user_id = $2 AND version = $3`,
            [reviewPoints, userId, loyalty.version],
          );
        } else {
          await client.query(
            `INSERT INTO konektag.loyalty_points (user_id, points, level) VALUES ($1, $2, 'bronze')`,
            [userId, reviewPoints],
          );
        }
      } catch {
        // Non-bloquant si la fidélité échoue
      }

      await client.query('COMMIT');

      // Fetch user name for response (username = identifiant public, pas de PII)
      const { rows: [userRow] } = await pool.query(
        `SELECT username AS display_name FROM konektag.users WHERE id = $1`,
        [userId],
      );

      return { ...review, userName: userRow?.display_name ?? null } as Review;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getMerchantReviews(slug: string, limit: number = 10, offset: number = 0): Promise<PaginatedReviews> {
    const { rows: [mp] } = await pool.query(
      `SELECT id FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    );
    if (!mp) return { reviews: [], total: 0, averageRating: 0 };

    const merchantId = mp.id;

    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) as total, COALESCE(ROUND(AVG(r.rating)::numeric, 1), 0) AS average_rating
       FROM konektag.reviews r WHERE r.merchant_id = $1 AND r.deleted_at IS NULL AND ${REVIEW_VISIBLE_SQL}`,
      [merchantId],
    );

    const { rows } = await pool.query(
      `SELECT r.*, u.username AS user_name,${VERIFIED_CUSTOMER_SQL} AS verified_customer,
         reply.content AS merchant_reply,reply.created_at AS merchant_reply_at
       FROM konektag.reviews r
       LEFT JOIN konektag.users u ON u.id = r.user_id
       LEFT JOIN LATERAL(SELECT content,created_at FROM konektag.review_merchant_replies WHERE review_id=r.id ORDER BY version DESC LIMIT 1) reply ON true
       WHERE r.merchant_id = $1 AND r.deleted_at IS NULL AND ${REVIEW_VISIBLE_SQL}
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [merchantId, limit, offset],
    );

    return {
      reviews: rows.map(r => ({ ...r, userName: r.user_name })) as Review[],
      total: parseInt(countRow.total, 10),
      averageRating: parseFloat(countRow.average_rating),
    };
  },

  async getUserReviewForMerchant(userId: string, merchantSlug: string): Promise<Review | null> {
    const { rows: [mp] } = await pool.query(
      `SELECT id FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`,
      [merchantSlug],
    );
    if (!mp) return null;

    const { rows: [review] } = await pool.query(
      `SELECT * FROM konektag.reviews WHERE user_id = $1 AND merchant_id = $2 AND deleted_at IS NULL`,
      [userId, mp.id],
    );
    return review ? (review as Review) : null;
  },
};


