import type { PoolClient } from 'pg';
import { ConcurrencyError } from '../../domain/DomainErrors.ts';

export interface KycOrderRow {
  id: string;
  user_id: string;
  status: string;
  id_document_path: string | null;
  selfie_path: string | null;
  ocr_data: Record<string, unknown> | null;
  clamav_result: Record<string, unknown> | null;
  face_match_result: Record<string, unknown> | null;
  liveness_result: Record<string, unknown> | null;
  rejection_reason: string | null;
  attempt: number;
  n8n_execution_id: string | null;
  correlation_id: string;
  verified_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  version: number;
}

export interface CreateKycOrderInput {
  userId: string;
  status: string;
  idDocumentPath: string;
  selfiePath: string | null;
  attempt: number;
  correlationId: string;
}

export class KycOrderRepository {
  constructor(private client: PoolClient) {}

  async findById(id: string): Promise<KycOrderRow | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.kyc_orders WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findLatestByUser(userId: string): Promise<KycOrderRow | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.kyc_orders
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async countAttempts(userId: string): Promise<number> {
    const { rows } = await this.client.query(
      `SELECT COUNT(*)::int AS count FROM konektag.kyc_orders
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    return rows[0].count;
  }

  async insert(data: CreateKycOrderInput): Promise<KycOrderRow> {
    const { rows } = await this.client.query(
      `INSERT INTO konektag.kyc_orders
       (user_id, status, id_document_path, selfie_path, attempt, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [data.userId, data.status, data.idDocumentPath, data.selfiePath,
       data.attempt, data.correlationId],
    );
    return rows[0];
  }

  async updateStatus(id: string, status: string, version: number): Promise<KycOrderRow> {
    const { rows } = await this.client.query(
      `UPDATE konektag.kyc_orders
       SET status = $1, version = version + 1
       WHERE id = $2 AND version = $3 AND deleted_at IS NULL
       RETURNING *`,
      [status, id, version],
    );
    if (rows.length === 0) throw new ConcurrencyError('KycOrder', id, version);
    return rows[0];
  }

  async findByUser(userId: string): Promise<KycOrderRow[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.kyc_orders
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  }
}
