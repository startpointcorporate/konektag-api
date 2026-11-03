import pool from '../../infrastructure/database/pool.ts';
import { emailService } from './resend-service.ts';
import { communicationConsentService } from './communication-consent-service.ts';
import type { ConsentChannel } from '../../domain/CommunicationConsent.ts';

export interface NotificationInput {
  userId: string;
  type: 'k_send' | 'qr_payment' | 'payment' | 'cashback' | 'system';
  title: string;
  body?: string;
  link?: string;
}

export const notificationService = {
  async create(input: NotificationInput) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO konektag.notifications (user_id, type, title, body, link)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.userId, input.type, input.title, input.body ?? null, input.link ?? null],
    );
    return row;
  },

  async listForUser(userId: string, limit = 20) {
    const { rows } = await pool.query(
      `SELECT * FROM konektag.notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows;
  },

  async unreadCount(userId: string): Promise<number> {
    const { rows: [row] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM konektag.notifications WHERE user_id = $1 AND is_read = FALSE`,
      [userId],
    );
    return row?.count ?? 0;
  },

  async markAsRead(id: string, userId: string) {
    await pool.query(
      `UPDATE konektag.notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
  },

  async markAllAsRead(userId: string) {
    await pool.query(
      `UPDATE konektag.notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
      [userId],
    );
  },

  async notifyWithConsent(input: NotificationInput & { channel: ConsentChannel }) {
    const allowed = await communicationConsentService.isChannelAllowed(input.userId, input.channel);
    if (!allowed) return;
    await this.create(input);
  },

  async notifyAndEmail(input: NotificationInput & { emailTemplate: string; emailTo: string; locale: string; emailData: Record<string, unknown> }) {
    const allowed = await communicationConsentService.isChannelAllowed(input.userId, 'email');
    if (!allowed) return;
    await this.create(input);
    try {
      await emailService.send({
        to: input.emailTo,
        subject: input.title,
        html: input.body || '',
      });
    } catch (err) {
      console.error('[Notification] Email failed:', err);
    }
  },
};

/** Persist operational notifications in the same transaction as the business event. */
export async function notifyMerchantTransaction(client: import('pg').PoolClient, input: {
  merchantProfileId: string; transactionId: string; version: number; state: string;
}) {
  await client.query(`INSERT INTO konektag.notifications(user_id,type,title,body,link,event_key)
    SELECT recipient::text, 'system', 'Transaction commerçant', $2, '/fr/merchant/terminal/?merchantProfileId=' || $1::text, $3
    FROM (
      SELECT user_id AS recipient FROM konektag.merchant_profiles WHERE id=$1 AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM konektag.merchant_memberships
      WHERE merchant_profile_id=$1 AND status='active' AND role IN ('owner','manager')
    ) recipients
    ON CONFLICT (event_key,user_id) DO NOTHING`,
    [input.merchantProfileId,
      `${input.transactionId} · ${input.state}`, `core:${input.transactionId}:${input.version}`]);
}
