import type { PoolClient } from 'pg';

export interface AuditLogInput {
  userId?: string | null;
  correlationId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export class AuditLogRepository {
  constructor(private client: PoolClient) {}

  async log(input: AuditLogInput): Promise<void> {
    await this.client.query(
      `INSERT INTO konektag.audit_logs (user_id, correlation_id, event_type, payload)
       VALUES ($1,$2,$3,$4)`,
      [input.userId ?? null, input.correlationId, input.eventType,
       JSON.stringify(input.payload)],
    );
  }
}
