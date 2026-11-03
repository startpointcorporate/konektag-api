import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), postTransaction: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { connect: mocks.connect } }));
vi.mock('../../src/application/services/accounting-service.ts', () => ({ accountingService: { postTransaction: mocks.postTransaction } }));
import { clearingService } from '../../src/application/services/clearing-service.ts';

describe('clearing gross position preservation', () => {
  it('preserves individual position snapshots through settlement and an identical retry', async () => {
    const sourcePositions = [
      { id: 'position-credit', legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', direction: 'B_TO_A', amount: '100', currency: 'XAF' },
      { id: 'position-debit', legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', direction: 'A_TO_B', amount: '40', currency: 'XAF' },
    ];
    const batch = {
      id: 'batch-1', status: 'FROZEN', legal_entity_id: 'entity-a', counterparty_entity_id: 'entity-b',
      b2b_profile_id: 'profile-1', batch_ref: 'CLR-entity-a-entity-b-XAF-2026-01-01-2026-01-31',
      currency: 'XAF', net_amount: '60', gross_amount: '60', netting_allowed: true, version: 1,
    };
    let batchCreated = false;
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('SELECT country_code, base_currency FROM konektag.legal_entities')) {
        return { rows: [{ country_code: 'CG', base_currency: 'XAF', id: parameters?.[0] }] };
      }
      if (sql.includes('daily_reconciliations')) return { rows: [] };
      if (sql.includes('SELECT id, status FROM konektag.clearing_batches')) return { rows: batchCreated ? [{ id: batch.id, status: batch.status }] : [] };
      if (sql.includes('SELECT id, netting_allowed')) return { rows: [{ id: 'profile-1', netting_allowed: true, legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', settlement_currency: 'XAF' }] };
      if (sql.includes('INSERT INTO konektag.clearing_batches')) {
        batchCreated = true;
        return { rows: [batch] };
      }
      if (sql.includes('FROM konektag.intercompany_positions') && sql.includes("status = 'OPEN'")) return { rows: sourcePositions };
      if (sql.includes('SELECT * FROM konektag.clearing_batches WHERE id')) return { rows: [batch] };
      if (sql.includes('FROM konektag.clearing_batches cb')) {
        return { rows: [{ ...batch, status: 'APPROVED', source_currency: 'XAF', target_currency: 'XAF', profile_settlement_currency: 'XAF', fx_evidence_id: null }] };
      }
      if (sql.includes('SELECT code, country_code')) return { rows: [{ code: 'KTG-CG', country_code: 'CG' }] };
      if (sql.includes("SET status = 'SETTLED'")) return { rows: [{ ...batch, status: 'SETTLED' }] };
      if (sql.includes('gross_receivable')) return { rows: [{ gross_receivable: '100', gross_payable: '40', regulatory_profile_id: 'reg-profile-1', profile_count: '1', missing_profile_count: '0', corridor: 'FR-CG', corridor_count: '1', missing_corridor_count: '0' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    mocks.postTransaction.mockResolvedValue({ success: true });
    const command = { periodStart: '2026-01-01', periodEnd: '2026-01-31', legalEntityId: 'entity-a', counterpartyEntityId: 'entity-b', currency: 'XAF', b2bProfileId: 'profile-1', initiatedBy: 'maker' };

    await clearingService.freezeBatch(command);
    const snapshotInserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO konektag.clearing_batch_positions'));
    expect(snapshotInserts).toHaveLength(2);
    expect(snapshotInserts.map(([, parameters]) => parameters)).toEqual([
      ['batch-1', 'position-credit', '100', 'XAF'],
      ['batch-1', 'position-debit', '40', 'XAF'],
    ]);
    expect(query.mock.calls.find(([sql]) => sql.includes('SET gross_amount'))?.[1]).toEqual([140, 60, 2, 'batch-1']);
    expect(query.mock.calls.find(([sql]) => sql.includes("status = 'OPEN'"))?.[0]).toContain('legal_entity_a_id, legal_entity_b_id, direction');

    await clearingService.freezeBatch(command);
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO konektag.clearing_batch_positions'))).toHaveLength(2);
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO konektag.clearing_batches'))).toHaveLength(1);

    const beforeSettlement = query.mock.calls.length;
    await clearingService.markSettled({ batchId: 'batch-1', bankProofUrl: 'https://bank/proof', cobacJustificationUrl: 'https://cobac/proof', settledBy: 'operator-1' });
    const settlementSql = query.mock.calls.slice(beforeSettlement).map(([sql]) => sql as string);
    expect(mocks.postTransaction).toHaveBeenCalledTimes(2);
    expect(settlementSql.some(sql => /(?:DELETE|UPDATE)\s+.*clearing_batch_positions/i.test(sql))).toBe(false);
    expect(settlementSql.some(sql => /DELETE\s+FROM\s+konektag\.intercompany_positions/i.test(sql))).toBe(false);
  });
});
