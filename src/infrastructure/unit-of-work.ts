import type { PoolClient } from 'pg';
import pool from './database/pool.ts';
import { UserRepository } from './repositories/user-repository.ts';
import { KycOrderRepository } from './repositories/kyc-order-repository.ts';
import { AuditLogRepository } from './repositories/audit-log-repository.ts';
import { OutboxRepository } from './repositories/outbox-repository.ts';
import { IdempotencyRepository } from './repositories/idempotency-repository.ts';
import { PreferencesRepository } from './repositories/preferences-repository.ts';
import { ConfigurationRepository } from './repositories/configuration-repository.ts';
import { CommunicationConsentRepository } from './repositories/communication-consent-repository.ts';

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ';

export interface TransactionalRepositories {
  client: PoolClient;
  userRepo: UserRepository;
  kycOrderRepo: KycOrderRepository;
  auditRepo: AuditLogRepository;
  outboxRepo: OutboxRepository;
  idempotencyRepo: IdempotencyRepository;
  preferencesRepo: PreferencesRepository;
  configRepo: ConfigurationRepository;
  communicationConsentRepo: CommunicationConsentRepository;
}

export class UnitOfWork {
  private client: PoolClient | null = null;

  async execute<T>(
    work: (tx: TransactionalRepositories) => Promise<T>,
    isolation: IsolationLevel = 'READ COMMITTED',
  ): Promise<T> {
    this.client = await pool.connect();

    try {
      await this.client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await this.client.query('SET LOCAL statement_timeout = 30000');

      const tx: TransactionalRepositories = {
        client: this.client,
        userRepo: new UserRepository(this.client),
        kycOrderRepo: new KycOrderRepository(this.client),
        auditRepo: new AuditLogRepository(this.client),
        outboxRepo: new OutboxRepository(this.client),
        idempotencyRepo: new IdempotencyRepository(this.client),
        preferencesRepo: new PreferencesRepository(this.client),
        configRepo: new ConfigurationRepository(this.client),
        communicationConsentRepo: new CommunicationConsentRepository(this.client),
      };

      const result = await work(tx);
      await this.client.query('COMMIT');
      return result;

    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;

    } finally {
      this.client?.release();
      this.client = null;
    }
  }
}
