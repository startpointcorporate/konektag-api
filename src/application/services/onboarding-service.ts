import crypto from 'node:crypto';
import { encryptionService } from '../../infrastructure/adapters/encryption-service.ts';
import { keycloakAdapter } from '../../infrastructure/adapters/keycloak-adapter.ts';
import { UnitOfWork } from '../../infrastructure/unit-of-work.ts';
import { stateMachine } from '../../domain/OnboardingStateMachine.ts';
import { OnboardingError, NotFoundError } from '../../domain/DomainErrors.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';
import { ALL_CHANNELS } from '../../domain/CommunicationConsent.ts';
import type { UserRow } from '../../infrastructure/repositories/user-repository.ts';
import type { LegalDocumentEvidence } from './legal-document-service.ts';

export interface RegisterInput {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  locale: string;
  acceptedTerms: boolean;
  legalCountry: string;
  legalDocuments: LegalDocumentEvidence[];
}

export interface RegisterResult {
  user: UserRow;
  accessToken: string;
  refreshToken: string;
}

export class OnboardingService {
  constructor(
    private uow: UnitOfWork,
  ) {}

  async register(
    input: RegisterInput,
    idempotencyKey: string,
  ): Promise<RegisterResult> {
    const correlationId = getCorrelationId();
    const requestHash = crypto.createHash('sha256')
      .update(JSON.stringify(input)).digest('hex');

    // Idempotence check
    await this.uow.execute(async (tx) => {
      const existing = await tx.idempotencyRepo.findByKey(idempotencyKey);
      if (existing) {
        throw new OnboardingError('IDEMPOTENCY_CONFLICT');
      }
      await tx.idempotencyRepo.insert(idempotencyKey, requestHash);
    });

    // Register
    return this.uow.execute(async (tx) => {
      // 1. Création Keycloak
      const keycloakId = await keycloakAdapter.createUser({
        username: input.username,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        password: input.password,
        phone: input.phone,
        locale: input.locale,
        requiredActions: [],
        attributes: { onboarding_state: 'OTP_VERIFIED' },
        // For E2E registration flow, set email as verified
        emailVerified: true,
      });

      // 2. Chiffrement PII
      const encryptedData = encryptionService.encrypt(JSON.stringify({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
      }));

      // 3. PG insert — si échec, compensation Keycloak
      let user: UserRow;
      try {
       user = await tx.userRepo.insert({
          keycloakId,
          username: input.username,
          email: input.email,
          phone: input.phone,
          locale: input.locale,
          state: 'OTP_VERIFIED',
          paymentOtpEmail: input.email,
          kSendHistoryEmail: input.email,
        }, encryptedData);
        await tx.userRepo.markEmailVerified(user.id);
        const terms = input.legalDocuments.find((document) => document.type === 'terms')!;
        const privacy = input.legalDocuments.find((document) => document.type === 'privacy')!;
        await tx.client.query(
          `UPDATE konektag.users SET legal_country = $1, cgu_accepted_version = $2, cgu_accepted_at = now(),
           privacy_accepted_version = $3, privacy_accepted_at = now() WHERE id = $4`,
          [input.legalCountry, terms.version, privacy.version, user.id],
        );
        await tx.client.query(
          `INSERT INTO konektag.legal_consents
           (user_id, accepted, legal_country, terms_document_id, terms_version, terms_hash, terms_content_snapshot, terms_url,
            privacy_document_id, privacy_version, privacy_hash, privacy_content_snapshot, privacy_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [user.id, input.acceptedTerms, input.legalCountry, terms.id, terms.version, terms.hash, terms.content, terms.url,
           privacy.id, privacy.version, privacy.hash, privacy.content, privacy.url],
        );
      } catch (error) {
        await keycloakAdapter.deleteUser(keycloakId);
        throw error;
      }

      // 4. Audit — AUCUNE PII
      await tx.auditRepo.log({
        userId: user.id,
        correlationId,
        eventType: 'USER_CREATED',
        payload: { username: input.username, locale: input.locale, legalCountry: input.legalCountry },
      });

      // 5. Outbox
      await tx.outboxRepo.insert({
        correlationId,
        aggregateType: 'User',
        aggregateId: user.id,
        eventType: 'UserRegistered',
        eventVersion: 1,
        payload: {
          userId: user.id,
          keycloakId: user.keycloak_id,
          emailHash: user.email_hash,
          locale: input.locale,
          legalCountry: input.legalCountry,
        },
      });

      // 6. Idempotency result
      await tx.idempotencyRepo.storeResult(idempotencyKey, 201, { userId: user.id });

      // 7. Authentification
      const tokens = await keycloakAdapter.directGrant(input.username, input.password);

      return { user, ...tokens };
    });
  }

  async verifyOtp(email: string, code: string): Promise<boolean> {
    const { redisAdapter } = await import('../../infrastructure/adapters/redis-adapter.ts');
    return redisAdapter.verifyOtp(email, code);
  }


  async skipKyc(userId: string): Promise<void> {
    const correlationId = getCorrelationId();

    await this.uow.execute(async (tx) => {
      const user = await tx.userRepo.findById(userId);
      if (!user) throw new NotFoundError('User', userId);

      stateMachine.assertTransition(user.state, 'KYC_SKIPPED');

      await tx.userRepo.updateState(user.id, 'KYC_SKIPPED', user.version);

      await tx.auditRepo.log({
        userId,
        correlationId,
        eventType: 'ONBOARDING_STATE_CHANGED',
        payload: { from: user.state, to: 'KYC_SKIPPED' },
      });

      await tx.outboxRepo.insert({
        correlationId,
        aggregateType: 'User',
        aggregateId: user.id,
        eventType: 'KycSkipped',
        eventVersion: 1,
        payload: { userId },
      });
    }, 'REPEATABLE READ');
  }

  async completeOnboarding(userId: string): Promise<void> {
    const correlationId = getCorrelationId();

    let keycloakId: string;

    await this.uow.execute(async (tx) => {
      const user = await tx.userRepo.findById(userId);
      if (!user) throw new NotFoundError('User', userId);

      stateMachine.assertTransition(user.state, 'COMPLETED');

      await tx.userRepo.updateState(user.id, 'COMPLETED', user.version);
      keycloakId = user.keycloak_id;

      for (const channel of ALL_CHANNELS) {
        const existing = await tx.communicationConsentRepo.findByUserAndChannel(userId, channel);
        if (!existing) {
          await tx.communicationConsentRepo.upsert(userId, channel, 'granted', 'onboarding', null);
        }
      }

      await tx.auditRepo.log({
        userId,
        correlationId,
        eventType: 'ONBOARDING_COMPLETED',
        payload: { completed_at: new Date().toISOString() },
      });

      await tx.outboxRepo.insert({
        correlationId,
        aggregateType: 'User',
        aggregateId: user.id,
        eventType: 'OnboardingCompleted',
        eventVersion: 1,
        payload: { userId },
      });
    }, 'REPEATABLE READ');

    // POST-COMMIT : synchro Keycloak
    await keycloakAdapter.updateUserAttributes(keycloakId!, {
      onboarding_state: 'COMPLETED',
    });
  }
}

export const onboardingService = new OnboardingService(new UnitOfWork());
