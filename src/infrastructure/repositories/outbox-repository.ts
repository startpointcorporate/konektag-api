import type { PoolClient } from 'pg';

export interface OutboxEventInput {
  correlationId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
}

export class OutboxRepository {
  constructor(private client: PoolClient) {}

  async insert(input: OutboxEventInput): Promise<void> {
    await this.client.query(
      `INSERT INTO konektag.outbox_events
       (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.correlationId, input.aggregateType, input.aggregateId,
       input.eventType, input.eventVersion, JSON.stringify(input.payload)],
    );
  }
}
