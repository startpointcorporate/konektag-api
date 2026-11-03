import { stateMachine } from '../../domain/OnboardingStateMachine.ts';
import { NotFoundError, OnboardingError } from '../../domain/DomainErrors.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';
import { UnitOfWork } from '../../infrastructure/unit-of-work.ts';
import { minioAdapter } from '../../infrastructure/adapters/minio-adapter.ts';
import { redisAdapter } from '../../infrastructure/adapters/redis-adapter.ts';
import pool from '../../infrastructure/database/pool.ts';
import type { KycOrderRow } from '../../infrastructure/repositories/kyc-order-repository.ts';
import type { FileInput } from '../../infrastructure/adapters/minio-adapter.ts';
import { UserRepository } from '../../infrastructure/repositories/user-repository.ts';
import { KycOrderRepository } from '../../infrastructure/repositories/kyc-order-repository.ts';
import { processKycOrder } from './kyc-processor.ts';

export class KycService {
  constructor(private uow: UnitOfWork) {}

  async initKyc(
    userId: string,
    idDocumentFile: FileInput,
  ): Promise<KycOrderRow> {
    const correlationId = getCorrelationId();

    const idDocPath = await minioAdapter.uploadQuarantine(userId, idDocumentFile, 'id_document');

    const order = await this.uow.execute(async (tx) => {
      const user = await tx.userRepo.findById(userId);
      if (!user) throw new NotFoundError('User', userId);

      stateMachine.assertTransition(user.state, 'KYC_PENDING');

      const attempt = await tx.kycOrderRepo.countAttempts(userId) + 1;

      const order = await tx.kycOrderRepo.insert({
        userId,
        status: 'quarantined',
        idDocumentPath: idDocPath,
        selfiePath: null,
        attempt,
        correlationId,
      });

      await tx.userRepo.updateState(user.id, 'KYC_PENDING', user.version);

      await tx.auditRepo.log({
        userId,
        correlationId,
        eventType: 'KYC_STARTED',
        payload: { kycOrderId: order.id, attempt },
      });

      await tx.outboxRepo.insert({
        correlationId,
        aggregateType: 'KycOrder',
        aggregateId: order.id,
        eventType: 'KycSubmitted',
        eventVersion: 1,
        payload: {
          userId,
          kycOrderId: order.id,
          attempt,
          idDocumentPath: idDocPath,
        },
      });

      return order;
    });

    // POST-COMMIT : lancer le traitement KYC immédiatement
    processKycOrder(order.id).catch(err =>
      console.error(`[kyc] Processor error for order ${order.id}:`, err)
    );

    return order;
  }

  async getStatus(userId: string): Promise<{
    state: string;
    kycStatus: string;
    currentOrder: KycOrderRow | null;
    history: KycOrderRow[];
  }> {
    const { rows: [user] } = await pool.query(
      `SELECT state FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!user) throw new NotFoundError('User', userId);

    const client = await pool.connect();
    try {
      const repo = new KycOrderRepository(client);
      const currentOrder = await repo.findLatestByUser(userId);
      const allOrders = await repo.findByUser(userId);

      // Le statut KYC réel vient du dernier kyc_order, pas de la state machine
      let kycStatus = 'none';
      if (currentOrder) {
        if (currentOrder.status === 'verified') kycStatus = 'verified';
        else if (currentOrder.status === 'pending_review') kycStatus = 'pending_review';
        else if (currentOrder.status === 'rejected') kycStatus = 'rejected';
        else kycStatus = currentOrder.status; // pending, quarantined, scanning, processing
      }

      return {
        state: user.state,
        kycStatus,
        currentOrder,
        history: allOrders,
      };
    } finally {
      client.release();
    }
  }

  async resubmitKyc(
    userId: string,
    idDocumentFile?: FileInput,
    selfieFile?: FileInput,
  ): Promise<KycOrderRow> {
    const correlationId = getCorrelationId();

    // Recharger le dernier ordre
    const client = await pool.connect();
    let lastOrder;
    try {
      lastOrder = await new KycOrderRepository(client).findLatestByUser(userId);
    } finally {
      client.release();
    }

    if (!lastOrder || lastOrder.status !== 'rejected') {
      throw new OnboardingError('NO_REJECTED_ORDER');
    }

    let idDocPath = lastOrder.id_document_path;
    let selfiePath = lastOrder.selfie_path;

    // Upload nouveaux fichiers si fournis
    if (idDocumentFile) {
      idDocPath = await minioAdapter.uploadQuarantine(userId, idDocumentFile, 'id_document');
    }
    if (selfieFile) {
      selfiePath = await minioAdapter.uploadQuarantine(userId, selfieFile, 'selfie');
    }

    const order = await this.uow.execute(async (tx) => {
      const user = await tx.userRepo.findById(userId);
      if (!user) throw new NotFoundError('User', userId);

      stateMachine.assertTransition(user.state, 'KYC_PENDING');

      const order = await tx.kycOrderRepo.insert({
        userId,
        status: 'quarantined',
        idDocumentPath: idDocPath!,
        selfiePath: selfiePath!,
        attempt: lastOrder.attempt + 1,
        correlationId,
      });

      await tx.userRepo.updateState(user.id, 'KYC_PENDING', user.version);

      await tx.auditRepo.log({
        userId,
        correlationId,
        eventType: 'KYC_RESUBMITTED',
        payload: { kycOrderId: order.id, attempt: order.attempt },
      });

      await tx.outboxRepo.insert({
        correlationId,
        aggregateType: 'KycOrder',
        aggregateId: order.id,
        eventType: 'KycSubmitted',
        eventVersion: 1,
        payload: {
          userId,
          kycOrderId: order.id,
          attempt: order.attempt,
          idDocumentPath: idDocPath!,
          selfiePath: selfiePath!,
        },
      });

      return order;
    });

    // POST-COMMIT : lancer le traitement KYC immédiatement
    processKycOrder(order.id).catch(err =>
      console.error(`[kyc] Processor error for order ${order.id}:`, err)
    );

    return order;
  }
}

export const kycService = new KycService(new UnitOfWork());
