import type { PoolClient } from 'pg';

export class IdempotencyRepository {
  constructor(private client: PoolClient) {}

  async findByKey(key: string): Promise<{ response_body: unknown } | null> {
    const { rows } = await this.client.query(
      `SELECT response_body FROM konektag.idempotency_keys
       WHERE idempotency_key = $1 AND expires_at > now()`,
      [key],
    );
    return rows[0] ?? null;
  }

  async insert(key: string, requestHash: string, ttlHours = 24): Promise<void> {
    await this.client.query(
      `INSERT INTO konektag.idempotency_keys (idempotency_key, request_hash, expires_at)
       VALUES ($1, $2, now() + INTERVAL '${ttlHours} hours')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, requestHash],
    );
  }

  async storeResult(key: string, status: number, body: unknown): Promise<void> {
    await this.client.query(
      `UPDATE konektag.idempotency_keys
       SET response_status = $2, response_body = $3
       WHERE idempotency_key = $1`,
      [key, status, JSON.stringify(body)],
    );
  }
}
