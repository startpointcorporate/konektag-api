import type { PoolClient } from 'pg';

export interface HttpIdempotencyRecord {
  id: string;
  actorId: string;
  httpMethod: string;
  normalizedPath: string;
  idempotencyKey: string;
  commandHash: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  expiresAt: Date;
  createdAt: Date;
  completedAt: Date | null;
}

export interface FinancialIdempotencyScope {
  actorType: 'USER' | 'MERCHANT' | 'ADMIN' | 'SERVICE';
  actorId: string;
  legalEntityId: string | null;
  routeKey: string;
}

export class HttpIdempotencyRepository {
  constructor(private client: PoolClient) {}

  async findByKey(
    actorId: string,
    method: string,
    path: string,
    key: string
  ): Promise<HttpIdempotencyRecord | null> {
    const { rows } = await this.client.query(
       `SELECT * FROM konektag.http_idempotency_requests
        WHERE actor_id = $1 AND http_method = $2 AND normalized_path = $3
          AND idempotency_key = $4 AND actor_type IS NULL AND expires_at > now()`,
      [actorId, method, path, key]
    );
    if (!rows[0]) return null;
    return this.mapRow(rows[0]);
  }

  async insert(
    actorId: string,
    method: string,
    path: string,
    key: string,
    commandHash: string,
    ttlHours = 24
  ): Promise<HttpIdempotencyRecord> {
    const { rows } = await this.client.query(
      `INSERT INTO konektag.http_idempotency_requests
       (actor_id, http_method, normalized_path, idempotency_key, command_hash, status, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'PROCESSING', now() + INTERVAL '${ttlHours} hours')
        ON CONFLICT (actor_id, http_method, normalized_path, idempotency_key)
        WHERE actor_type IS NULL
        DO NOTHING
       RETURNING *`,
      [actorId, method, path, key, commandHash]
    );
    if (!rows[0]) return null as any;
    return this.mapRow(rows[0]);
  }

  async insertOrGetConflict(
    actorId: string,
    method: string,
    path: string,
    key: string,
    commandHash: string,
    ttlHours = 24
  ): Promise<{ inserted: HttpIdempotencyRecord | null; existing: HttpIdempotencyRecord | null; hashConflict: boolean }> {
    const existing = await this.findByKey(actorId, method, path, key);
    if (existing) {
      const hashConflict = existing.commandHash !== commandHash;
      return { inserted: null, existing, hashConflict };
    }

    const inserted = await this.insert(actorId, method, path, key, commandHash, ttlHours);
    if (!inserted) {
      const retry = await this.findByKey(actorId, method, path, key);
      return { inserted: null, existing: retry, hashConflict: retry ? retry.commandHash !== commandHash : false };
    }

    return { inserted, existing: null, hashConflict: false };
  }

  async insertOrGetFinancialConflict(
    scope: FinancialIdempotencyScope,
    key: string,
    fingerprint: string,
    ttlHours = 24,
  ): Promise<{ inserted: HttpIdempotencyRecord | null; existing: HttpIdempotencyRecord | null; hashConflict: boolean }> {
    const { rows } = await this.client.query(
      `INSERT INTO konektag.http_idempotency_requests
       (actor_type, actor_id, legal_entity_id, route_key, http_method, normalized_path, idempotency_key, command_hash, request_fingerprint, status, expires_at)
       VALUES ($1,$2,$3,$4,'POST',$4,$5,$6,$6,'PROCESSING',now() + ($7::text || ' hours')::interval)
       ON CONFLICT ${scope.legalEntityId === null
         ? '(actor_type, actor_id, route_key, idempotency_key) WHERE actor_type IS NOT NULL AND legal_entity_id IS NULL AND route_key IS NOT NULL'
         : '(actor_type, actor_id, legal_entity_id, route_key, idempotency_key) WHERE actor_type IS NOT NULL AND legal_entity_id IS NOT NULL AND route_key IS NOT NULL'}
       DO NOTHING RETURNING *`,
      [scope.actorType, scope.actorId, scope.legalEntityId, scope.routeKey, key, fingerprint, ttlHours],
    );
    if (rows[0]) return { inserted: this.mapRow(rows[0]), existing: null, hashConflict: false };
    const existing = await this.client.query(
      `SELECT * FROM konektag.http_idempotency_requests WHERE actor_type=$1 AND actor_id=$2 AND legal_entity_id IS NOT DISTINCT FROM $3::uuid AND route_key=$4 AND idempotency_key=$5 AND expires_at > now()`,
      [scope.actorType, scope.actorId, scope.legalEntityId, scope.routeKey, key],
    );
    const record = existing.rows[0] ? this.mapRow(existing.rows[0]) : null;
    return { inserted: null, existing: record, hashConflict: !!record && record.commandHash !== fingerprint };
  }

  async completeResponse(
    id: string,
    status: 'COMPLETED' | 'FAILED',
    responseStatus: number,
    responseHeaders: Record<string, string>,
    responseBody: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE konektag.http_idempotency_requests
       SET status = $2, response_status = $3, response_headers = $4,
           response_body = $5, completed_at = now()
       WHERE id = $1`,
      [id, status, responseStatus, JSON.stringify(responseHeaders), responseBody]
    );
  }

  async markFailed(id: string): Promise<void> {
    await this.client.query(
      `UPDATE konektag.http_idempotency_requests
       SET status = 'FAILED', completed_at = now()
       WHERE id = $1`,
      [id]
    );
  }

  async cleanupExpired(): Promise<number> {
    const { rows } = await this.client.query(
      `DELETE FROM konektag.http_idempotency_requests WHERE expires_at < now() RETURNING id`
    );
    return rows.length;
  }

  private mapRow(row: any): HttpIdempotencyRecord {
    return {
      id: row.id,
      actorId: row.actor_id,
      httpMethod: row.http_method,
      normalizedPath: row.normalized_path,
      idempotencyKey: row.idempotency_key,
      commandHash: row.command_hash,
      status: row.status,
      responseStatus: row.response_status,
      responseHeaders: row.response_headers,
      responseBody: row.response_body,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
