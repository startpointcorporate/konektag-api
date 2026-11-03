import { stateMachine } from '../../domain/OnboardingStateMachine.ts';
import { NotFoundError } from '../../domain/DomainErrors.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';
import { UnitOfWork } from '../../infrastructure/unit-of-work.ts';
import pool from '../../infrastructure/database/pool.ts';

export class PreferencesService {
  constructor(private uow: UnitOfWork) {}

  async getFeatures() {
    const { rows } = await pool.query(
      `SELECT * FROM konektag.features WHERE is_active = true AND deleted_at IS NULL
       ORDER BY sort_order`,
    );
    return rows;
  }

  async savePreferences(userId: string, featureKeys: string[]): Promise<void> {
    const correlationId = getCorrelationId();

    await this.uow.execute(async (tx) => {
      const user = await tx.userRepo.findById(userId);
      if (!user) throw new NotFoundError('User', userId);

      stateMachine.assertTransition(user.state, 'FEATURES_SELECTED');

      await tx.preferencesRepo.upsert(userId, featureKeys);
      await tx.userRepo.updateState(user.id, 'FEATURES_SELECTED', user.version);

      await tx.auditRepo.log({
        userId,
        correlationId,
        eventType: 'PREFERENCES_SAVED',
        payload: { features: featureKeys },
      });

      await tx.outboxRepo.insert({
        correlationId,
        aggregateType: 'User',
        aggregateId: user.id,
        eventType: 'PreferencesSaved',
        eventVersion: 1,
        payload: { userId, features: featureKeys },
      });
    }, 'REPEATABLE READ');
  }
}

export const preferencesService = new PreferencesService(new UnitOfWork());
