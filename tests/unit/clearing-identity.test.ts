import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/application/services/operation-currency-service.ts', () => ({ resolveLegalEntityCurrency: vi.fn().mockResolvedValue({ country: 'CG', currency: 'XAF' }) }));

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { connect: mocks.connect } }));
vi.mock('../../src/application/services/accounting-service.ts', () => ({ accountingService: { postTransaction: vi.fn() } }));
import { clearingService } from '../../src/application/services/clearing-service.ts';

describe('clearing identity', () => {
  it('returns the existing deterministic batch on an identical retry', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('daily_reconciliations')) return { rows: [] };
      if (sql.includes('batch_ref')) return { rows: [{ id: 'batch-1', status: 'FROZEN' }] };
      if (sql.includes('WHERE id = $1')) return { rows: [{ id: 'batch-1', status: 'FROZEN' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    const result = await clearingService.freezeBatch({ periodStart: '2026-01-01', periodEnd: '2026-01-31', legalEntityId: 'entity-a', counterpartyEntityId: 'entity-b', currency: 'XAF', b2bProfileId: 'profile', initiatedBy: 'maker' });
    expect(result.id).toBe('batch-1');
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});
