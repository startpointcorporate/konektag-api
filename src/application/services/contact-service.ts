import pool from '../../infrastructure/database/pool.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';

export interface ContactMessage {
  id: string;
  profileId: string;
  senderName: string;
  senderEmail: string;
  senderPhone: string | null;
  message: string;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export const contactService = {
  async sendMessage(slug: string, senderName: string, senderEmail: string, message: string, senderPhone?: string, actorId?: string): Promise<ContactMessage> {
    const { rows: [mp] } = await pool.query(
      `SELECT id, user_id, business_name FROM konektag.merchant_profiles WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    );
    if (!mp) throw new Error('Établissement introuvable');

    const profileId = mp.id;
    const correlationId = getCorrelationId();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [msg] } = await client.query(
        `INSERT INTO konektag.contact_messages (profile_id, sender_name, sender_email, sender_phone, message)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [profileId, senderName, senderEmail, senderPhone ?? null, message],
      );

      // Envoyer un event outbox pour notification au commerçant
      if (mp.user_id) {
        await client.query(
          `INSERT INTO konektag.outbox_events (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
           VALUES ($1, 'MerchantProfile', $2, 'NewContactMessage', 1, $3)`,
          [correlationId, mp.id, JSON.stringify({
            messageId: msg.id,
            profileId,
            senderName,
            senderEmail,
            messagePreview: message.slice(0, 100),
            businessName: mp.business_name,
            userId: mp.user_id,
          })],
        );
      }

      // Count only a persisted internal message, in the same transaction.
      // Owner/manager self-interactions remain excluded from visibility metrics.
      if (actorId !== mp.user_id) {
        const { rows: [member] } = actorId ? await client.query(
          `SELECT 1 FROM konektag.merchant_memberships WHERE merchant_profile_id=$1 AND user_id=$2 AND status='active' AND removed_at IS NULL LIMIT 1`,
          [profileId, actorId],
        ) : { rows: [] };
        if (!member) await client.query(
          `INSERT INTO konektag.profile_analytics (profile_id,event_type,event_metadata)
           VALUES ($1,'message_sent',$2::jsonb)`,
          [profileId, JSON.stringify({ messageId: msg.id })],
        );
      }

      await client.query('COMMIT');
      return msg as ContactMessage;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getMessages(userId: string, limit: number = 20, offset: number = 0): Promise<{ messages: ContactMessage[]; total: number; unreadCount: number }> {
    // Récupère les messages pour tous les profils dont l'utilisateur est propriétaire
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) as total,
              COALESCE(SUM(CASE WHEN cm.is_read = FALSE THEN 1 ELSE 0 END), 0) AS unread_count
       FROM konektag.contact_messages cm
       JOIN konektag.merchant_profiles mp ON mp.id = cm.profile_id
       WHERE mp.user_id = $1 AND cm.deleted_at IS NULL`,
      [userId],
    );

    const { rows } = await pool.query(
      `SELECT cm.*, mp.business_name, mp.slug
       FROM konektag.contact_messages cm
       JOIN konektag.merchant_profiles mp ON mp.id = cm.profile_id
       WHERE mp.user_id = $1 AND cm.deleted_at IS NULL
       ORDER BY cm.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    return {
      messages: rows as ContactMessage[],
      total: parseInt(countRow.total, 10),
      unreadCount: parseInt(countRow.unread_count, 10),
    };
  },

  async markAsRead(messageId: string): Promise<void> {
    await pool.query(
      `UPDATE konektag.contact_messages SET is_read = TRUE, updated_at = now(), version = version + 1 WHERE id = $1`,
      [messageId],
    );
  },

  async getUnreadCount(userId: string): Promise<number> {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*) as count
       FROM konektag.contact_messages cm
       JOIN konektag.merchant_profiles mp ON mp.id = cm.profile_id
       WHERE mp.user_id = $1 AND cm.is_read = FALSE AND cm.deleted_at IS NULL`,
      [userId],
    );
    return parseInt(row.count, 10);
  },
};
