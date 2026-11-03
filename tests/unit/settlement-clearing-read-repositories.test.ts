import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MerchantSettlementRepository } from '../../src/infrastructure/repositories/merchant-settlement-repository.ts';
import { ClearingRepository } from '../../src/infrastructure/repositories/clearing-repository.ts';

describe('PostgreSQL settlement and clearing reads', () => {
  const query = vi.fn();

  beforeEach(() => query.mockReset());

  it('scopes merchant settlements through active memberships', async () => {
    query.mockResolvedValue({ rows: [] });
    await new MerchantSettlementRepository({ query } as any).list({ userId: 'user-1', limit: 30 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('merchant_memberships'), ['user-1', 30]);
    expect(query.mock.calls[0][0]).toContain("mm.status = 'active'");
  });

  it('maps authoritative settlement facts and accepts reference detail lookups', async () => {
    query.mockResolvedValue({ rows: [{
      id: 'settlement-1', settlement_ref: 'STL-1', merchant_profile_id: 'merchant-1',
      legal_entity_id: 'entity-1', period_start: '2026-08-01', period_end: '2026-08-02',
      gross_amount: '120', net_amount: '100', tax_amount: '5', commission_amount: '15',
      currency: 'XAF', status: 'SETTLED', version: 2, sales_count: 3,
    }] });
    const result = await new MerchantSettlementRepository({ query } as any).findById('STL-1');
    expect(query.mock.calls[0][0]).toContain('ms.settlement_ref = $1');
    expect(result).toMatchObject({ settlementRef: 'STL-1', netAmount: 100, salesCount: 3 });
  });

  it('loads immutable clearing position snapshots for detail responses', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        id: 'batch-1', batch_ref: 'CLR-1', legal_entity_id: 'a', counterparty_entity_id: 'b',
        period_start: '2026-08-01', period_end: '2026-08-02', position_count: 1,
        net_amount: '25', gross_amount: '25', currency: 'XAF', status: 'FROZEN',
        netting_allowed: true, version: 1,
      }] })
      .mockResolvedValueOnce({ rows: [{
        position_id: 'position-1', legal_entity_a_id: 'a', legal_entity_b_id: 'b',
        direction: 'A_TO_B', amount: '25', currency: 'XAF',
      }] });
    const result = await new ClearingRepository({ query } as any).findById('CLR-1');
    expect(query.mock.calls[1][0]).toContain('clearing_batch_positions');
    expect(result?.positions).toEqual([{ positionId: 'position-1', legalEntityAId: 'a', legalEntityBId: 'b', direction: 'A_TO_B', amount: 25, currency: 'XAF' }]);
  });
});
