import type { PoolClient } from 'pg';
import type { ConsentChannel, ConsentStatus, ConsentSource, CommunicationConsentRow } from '../../domain/CommunicationConsent.ts';

export class CommunicationConsentRepository {
  constructor(private client: PoolClient) {}

  async findByUser(userId: string): Promise<CommunicationConsentRow[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.communication_consents
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY channel`,
      [userId],
    );
    return rows;
  }

  async findByUserAndChannel(userId: string, channel: ConsentChannel): Promise<CommunicationConsentRow | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.communication_consents
       WHERE user_id = $1 AND channel = $2 AND deleted_at IS NULL`,
      [userId, channel],
    );
    return rows[0] ?? null;
  }

  async upsert(
    userId: string,
    channel: ConsentChannel,
    status: ConsentStatus,
    source: ConsentSource,
    ipAddress: string | null,
  ): Promise<CommunicationConsentRow> {
    const { rows } = await this.client.query(
      `INSERT INTO konektag.communication_consents (user_id, channel, status, source, ip_address)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, channel) WHERE deleted_at IS NULL
       DO UPDATE SET status = $3, source = $4, ip_address = $5,
                     granted_at = CASE WHEN $3 = 'denied' THEN communication_consents.granted_at ELSE now() END,
                     version = communication_consents.version + 1
       RETURNING *`,
      [userId, channel, status, source, ipAddress],
    );
    return rows[0];
  }

  async softDelete(userId: string, channel: ConsentChannel): Promise<void> {
    await this.client.query(
      `UPDATE konektag.communication_consents
       SET deleted_at = now(), version = version + 1
       WHERE user_id = $1 AND channel = $2 AND deleted_at IS NULL`,
      [userId, channel],
    );
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.client.query(
      `UPDATE konektag.communication_consents
       SET deleted_at = now(), version = version + 1
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
  }
}
