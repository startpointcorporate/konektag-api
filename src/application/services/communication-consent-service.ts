import { type ConsentChannel, type ConsentStatus, type ConsentSource, ALL_CHANNELS, DEFAULT_CONSENT_STATUS } from '../../domain/CommunicationConsent.ts';
import { NotFoundError } from '../../domain/DomainErrors.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';
import { UnitOfWork } from '../../infrastructure/unit-of-work.ts';

export class CommunicationConsentService {
  constructor(private uow: UnitOfWork) {}

  async getPreferences(userId: string): Promise<Record<ConsentChannel, ConsentStatus>> {
    return this.uow.execute(async (tx) => {
      const rows = await tx.communicationConsentRepo.findByUser(userId);
      const denied = new Set(rows.filter(r => r.status === 'denied').map(r => r.channel));
      const result: Record<string, ConsentStatus> = {};
      for (const ch of ALL_CHANNELS) {
        result[ch] = denied.has(ch) ? 'denied' : DEFAULT_CONSENT_STATUS;
      }
      return result as Record<ConsentChannel, ConsentStatus>;
    });
  }

  async updatePreference(
    userId: string,
    channel: ConsentChannel,
    status: ConsentStatus,
    source: ConsentSource,
    ipAddress: string | null,
  ): Promise<void> {
    const correlationId = getCorrelationId();

    await this.uow.execute(async (tx) => {
      const user = await tx.userRepo.findById(userId);
      if (!user) throw new NotFoundError('User', userId);

      const previous = await tx.communicationConsentRepo.findByUserAndChannel(userId, channel);

      await tx.communicationConsentRepo.upsert(userId, channel, status, source, ipAddress);

      await tx.auditRepo.log({
        userId,
        correlationId,
        eventType: 'communication.consent.updated',
        payload: {
          channel,
          previousStatus: previous?.status ?? null,
          newStatus: status,
          source,
        },
      });

      await tx.outboxRepo.insert({
        correlationId,
        aggregateType: 'User',
        aggregateId: user.id,
        eventType: 'CommunicationPreferencesUpdated',
        eventVersion: 1,
        payload: {
          userId,
          changes: [{
            channel,
            previousStatus: previous?.status ?? null,
            newStatus: status,
            source,
          }],
          updatedAt: new Date().toISOString(),
        },
      });
    }, 'REPEATABLE READ');
  }

  async updateMultiple(
    userId: string,
    preferences: Array<{ channel: ConsentChannel; status: ConsentStatus }>,
    source: ConsentSource,
    ipAddress: string | null,
  ): Promise<void> {
    for (const pref of preferences) {
      await this.updatePreference(userId, pref.channel, pref.status, source, ipAddress);
    }
  }

  async isChannelAllowed(userId: string, channel: ConsentChannel): Promise<boolean> {
    return this.uow.execute(async (tx) => {
      const consent = await tx.communicationConsentRepo.findByUserAndChannel(userId, channel);
      return consent?.status !== 'denied';
    });
  }

  async bulkCheck(usersIds: string[], channel: ConsentChannel): Promise<Record<string, boolean>> {
    if (usersIds.length === 0) return {};
    return this.uow.execute(async (tx) => {
      const placeholders = usersIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await tx.client.query(
        `SELECT user_id, status FROM konektag.communication_consents
         WHERE user_id IN (${placeholders})
           AND channel = $${usersIds.length + 1}
           AND deleted_at IS NULL`,
        [...usersIds, channel],
      );
      const denied = new Set(rows.filter(r => r.status === 'denied').map(r => r.user_id));
      const result: Record<string, boolean> = {};
      for (const uid of usersIds) {
        result[uid] = !denied.has(uid);
      }
      return result;
    });
  }
}

export const communicationConsentService = new CommunicationConsentService(new UnitOfWork());
