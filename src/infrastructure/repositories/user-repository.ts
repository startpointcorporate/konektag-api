import type { PoolClient } from 'pg';
import type { OnboardingState } from '../../domain/OnboardingStateMachine.ts';
import { ConcurrencyError } from '../../domain/DomainErrors.ts';

export interface UserRow {
  id: string;
  keycloak_id: string;
  username: string;
  email_hash: string;
  phone_hash: string | null;
  locale: string;
  state: OnboardingState;
  email_verified: boolean;
  phone_verified: boolean;
  encrypted_data: Buffer;
  id_document_url: string | null;
  email_verification_token: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  version: number;
}

export interface CreateUserInput {
  keycloakId: string;
  username: string;
  email: string;
  phone: string;
  locale: string;
  state: OnboardingState;
  paymentOtpEmail?: string;
  kSendHistoryEmail?: string;
}

export class UserRepository {
  constructor(private client: PoolClient) {}

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findByKeycloakId(keycloakId: string): Promise<UserRow | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [keycloakId],
    );
    return rows[0] ?? null;
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.users WHERE username = $1 AND deleted_at IS NULL`,
      [username],
    );
    return rows[0] ?? null;
  }

  async findByEmailHash(email: string): Promise<UserRow | null> {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.users WHERE email_hash = $1 AND deleted_at IS NULL`,
      [hash],
    );
    return rows[0] ?? null;
  }

  async findByPhoneHash(phone: string): Promise<UserRow | null> {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(phone.trim()).digest('hex');
    const { rows } = await this.client.query(
      `SELECT * FROM konektag.users WHERE phone_hash = $1 AND deleted_at IS NULL`,
      [hash],
    );
    return rows[0] ?? null;
  }

  async insert(data: CreateUserInput, encryptedData: Buffer): Promise<UserRow> {
    const { createHash } = await import('node:crypto');
    const emailHash = createHash('sha256').update(data.email.toLowerCase().trim()).digest('hex');
    const phoneHash = data.phone
      ? createHash('sha256').update(data.phone.trim()).digest('hex')
      : null;

    const { rows } = await this.client.query(
      `INSERT INTO konektag.users
       (keycloak_id, username, email_hash, phone_hash, locale, state, encrypted_data, payment_otp_email, k_send_history_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [data.keycloakId, data.username, emailHash, phoneHash,
       data.locale, data.state, encryptedData, data.email, data.email],
    );
    return rows[0];
  }

  async updateState(id: string, state: OnboardingState, version: number): Promise<UserRow> {
    const { rows } = await this.client.query(
      `UPDATE konektag.users
       SET state = $1, version = version + 1
       WHERE id = $2 AND version = $3 AND deleted_at IS NULL
       RETURNING *`,
      [state, id, version],
    );
    if (rows.length === 0) throw new ConcurrencyError('User', id, version);
    return rows[0];
  }

  async markPhoneVerified(id: string): Promise<void> {
    await this.client.query(
      `UPDATE konektag.users SET phone_verified = true WHERE id = $1`,
      [id],
    );
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.client.query(
      `UPDATE konektag.users SET email_verified = true WHERE id = $1`,
      [id],
    );
  }

  async updateEncryptedData(id: string, encryptedData: Buffer, version: number): Promise<UserRow> {
    const { rows } = await this.client.query(
      `UPDATE konektag.users
       SET encrypted_data = $1, version = version + 1
       WHERE id = $2 AND version = $3 AND deleted_at IS NULL
       RETURNING *`,
      [encryptedData, id, version],
    );
    if (rows.length === 0) throw new ConcurrencyError('User', id, version);
    return rows[0];
  }

  async softDelete(id: string): Promise<void> {
    await this.client.query(
      `UPDATE konektag.users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  }
}
