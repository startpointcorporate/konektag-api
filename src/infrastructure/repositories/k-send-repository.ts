import type { PoolClient, QueryResultRow } from 'pg';

export interface KSendIntentRow extends QueryResultRow {
  id: string;
  sender_user_id: string;
  sender_keycloak_id: string;
  recipient_user_id: string;
  recipient_keycloak_id: string;
  recipient_name: string;
  origin_country: string;
  destination_country: string;
  quantity_k: number | string;
  quote_expires_at: Date | string;
  status: string;
  funding_reference: string | null;
  operation_id: string | null;
  gift_depth: number | null;
  version: number;
  created_at: Date | string;
}

export class KSendRepository {
  constructor(private readonly client: Pick<PoolClient, 'query'>) {}

  async createIntent(input: {
    senderUserId: string;
    senderKeycloakId: string;
    recipientUserId: string;
    recipientKeycloakId: string;
    recipientName: string;
    originCountry: string;
    destinationCountry: string;
    quantityK: number;
  }): Promise<KSendIntentRow> {
    const { rows } = await this.client.query<KSendIntentRow>(
      `INSERT INTO konektag.k_send_intents
       (sender_user_id, sender_keycloak_id, recipient_user_id, recipient_keycloak_id,
        recipient_name, origin_country, destination_country, quantity_k,
        quote_expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + interval '5 minutes','Quoted')
       RETURNING *`,
      [input.senderUserId, input.senderKeycloakId, input.recipientUserId, input.recipientKeycloakId,
        input.recipientName, input.originCountry, input.destinationCountry, input.quantityK],
    );
    return rows[0]!;
  }

  async findById(id: string, lock = false): Promise<KSendIntentRow | null> {
    const { rows } = await this.client.query<KSendIntentRow>(
      `SELECT * FROM konektag.k_send_intents WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id],
    );
    return rows[0] ?? null;
  }

  async list(senderKeycloakId: string, status: string | undefined, limit: number, offset: number) {
    const params: unknown[] = [senderKeycloakId];
    const statusClause = status ? ` AND status = $${params.push(status)}` : '';
    params.push(limit, offset);
    const { rows } = await this.client.query<KSendIntentRow>(
      `SELECT *, count(*) OVER() AS total_count FROM konektag.k_send_intents
       WHERE sender_keycloak_id = $1${statusClause}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params,
    );
    return rows;
  }

  async count(senderKeycloakId: string, status?: string): Promise<number> {
    const params: unknown[] = [senderKeycloakId];
    const statusClause = status ? ` AND status = $${params.push(status)}` : '';
    const { rows } = await this.client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM konektag.k_send_intents
       WHERE sender_keycloak_id = $1${statusClause}`, params,
    );
    return Number(rows[0]?.total || 0);
  }

  async cancel(id: string, version: number): Promise<KSendIntentRow | null> {
    const { rows } = await this.client.query<KSendIntentRow>(
      `UPDATE konektag.k_send_intents
       SET status='Cancelled', cancelled_at=now(), updated_at=now(), version=version+1
       WHERE id=$1 AND version=$2 AND status IN ('Draft','Quoted','PendingFunding') RETURNING *`,
      [id, version],
    );
    return rows[0] ?? null;
  }

  async markFunded(id: string, version: number, facts: {
    authorizationReference: string; walletOperationId: string; sendDepth: number;
  }): Promise<KSendIntentRow> {
    const { rows } = await this.client.query<KSendIntentRow>(
      `UPDATE konektag.k_send_intents
       SET status='Funded', funding_reference=$3, operation_id=$4,
           gift_depth=$5, funded_at=now(), updated_at=now(), version=version+1
       WHERE id=$1 AND version=$2 AND status IN ('Draft','Quoted','PendingFunding') RETURNING *`,
      [id, version, facts.authorizationReference, facts.walletOperationId, facts.sendDepth],
    );
    if (!rows[0]) throw new Error('K_SEND_INTENT_CONFLICT');
    return rows[0];
  }
}
