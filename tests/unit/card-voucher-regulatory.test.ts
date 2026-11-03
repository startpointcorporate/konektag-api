import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), execute: vi.fn(), release: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../../src/application/services/financial-operation-service.ts', () => ({
  FinancialOperationService: class { execute = mocks.execute; },
}));
import { cardBatchService } from '../../src/application/services/card-batch-service.ts';

const card = { id: 'card-1', number: '1000000000000001', amount: 5000, status: 'SOLD', version: 1,
  pin: crypto.createHash('sha256').update('123456').digest('hex'), batchId: 'batch-1', legal_entity_id: 'entity-1', country_code: 'FR' };

describe('card voucher regulatory activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.execute.mockResolvedValue({ success: true, financialTransactionId: 'tx-1' });
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  function configure(profile: any, confirmation: any = { id: 'confirmation-1', declaration_ref: 'SALE-1' }) {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM konektag.cards WHERE number')) return { rows: [card] };
      if (sql.includes('FROM konektag.card_batches')) return { rows: [{ created_at: new Date().toISOString() }] };
      if (sql.includes('FROM konektag.users')) return { rows: [{ state: 'COMPLETED' }] };
      if (sql.includes('legal_entities')) return { rows: [{ id: 'entity-1', country_code: 'FR', base_currency: 'EUR' }] };
      if (sql.includes('regulatory_profiles')) return { rows: profile ? [profile] : [] };
      if (sql.includes('card_sale_declarations')) return { rows: confirmation ? [confirmation] : [] };
      if (sql.includes('INSERT INTO konektag.klots')) return { rows: [{ id: 'klot-1' }] };
      if (sql.includes("UPDATE konektag.cards SET status='ACTIVATED'")) return { rowCount: 1, rows: [] };
      return { rows: [] };
    });
  }
  const activate = () => cardBatchService.redeemCard(card.number, '123456', 'user-1', 'kc-1', 'ip', 'ua');
  const klotCalls = () => mocks.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO konektag.klots'));
  const mutationCalls = () => mocks.query.mock.calls.filter(([sql]) => sql.includes("status='ACTIVATED'"));

  it('rejects a voucher with a client-controlled or mismatched profile before KLot creation', async () => {
    configure(null);
    await expect(activate()).rejects.toThrow('CARD_PROFILE_RAIL_NOT_CONFIGURED');
    expect(klotCalls()).toHaveLength(0); expect(mocks.execute).not.toHaveBeenCalled(); expect(mutationCalls()).toHaveLength(0);
  });

  it('rejects a voucher with an unauthorized rail before KLot creation', async () => {
    configure({ id: 'profile-1', rail: 'stripe' });
    await expect(activate()).rejects.toThrow('CARD_PROFILE_RAIL_NOT_CONFIGURED');
    expect(klotCalls()).toHaveLength(0); expect(mocks.execute).not.toHaveBeenCalled(); expect(mutationCalls()).toHaveLength(0);
  });

  it('does not create a KLot when authoritative voucher confirmation fails', async () => {
    configure({ id: 'profile-1', rail: 'internal' }, null);
    await expect(activate()).rejects.toThrow('CARD_VOUCHER_CONFIRMATION_REQUIRED');
    expect(klotCalls()).toHaveLength(0); expect(mocks.execute).not.toHaveBeenCalled(); expect(mutationCalls()).toHaveLength(0);
  });

  it('creates the KLot only after profile rail and confirmation validation succeeds', async () => {
    configure({ id: 'profile-1', rail: 'internal' });
    await expect(activate()).resolves.toMatchObject({ success: true });
    const profile = mocks.query.mock.invocationCallOrder[mocks.query.mock.calls.findIndex(([sql]) => sql.includes('regulatory_profiles'))];
    const confirmation = mocks.query.mock.invocationCallOrder[mocks.query.mock.calls.findIndex(([sql]) => sql.includes('card_sale_declarations'))];
    const klot = mocks.query.mock.invocationCallOrder[mocks.query.mock.calls.findIndex(([sql]) => sql.includes('INSERT INTO konektag.klots'))];
    expect(profile).toBeLessThan(confirmation); expect(confirmation).toBeLessThan(klot);
    expect(klot).toBeLessThan(mocks.execute.mock.invocationCallOrder[0]); expect(mutationCalls()).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ currency: 'EUR' }));
  });

  it('returns the existing result on an identical retry without creating a second KLot', async () => {
    configure({ id: 'profile-1', rail: 'internal' });
    await activate();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM konektag.cards WHERE number')) return { rows: [{ ...card, status: 'ACTIVATED' }] };
      return { rows: [] };
    });
    await expect(activate()).resolves.toMatchObject({ success: true, amount: 5000 });
    expect(klotCalls()).toHaveLength(1);
  });
});
