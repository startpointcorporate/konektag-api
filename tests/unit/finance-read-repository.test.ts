import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: vi.fn() },
}));

import { FinanceReadRepository } from '../../src/infrastructure/repositories/finance-read-repository.ts';

describe('FinanceReadRepository', () => {
  it('maps and paginates K-lots with a deterministic PostgreSQL query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ klot_id: 'K-1', total_count: '41' }] });
    const repository = new FinanceReadRepository({ query } as any);

    await expect(repository.listKlots('rail-ref', 2, 25)).resolves.toEqual({
      data: [{ klot_id: 'K-1' }],
      total: 41,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM konektag.klots k'), ['%rail-ref%', 25, 25]);
    expect(query.mock.calls[0][0]).toContain('COUNT(*) OVER() AS total_count');
  });

  it('scopes merchant sales to the owner or an active membership', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new FinanceReadRepository({ query } as any);

    await repository.listMerchantSales({ merchantUserId: '00000000-0000-0000-0000-000000000001' });

    expect(query.mock.calls[0][0]).toContain('konektag.merchant_memberships');
    expect(query.mock.calls[0][0]).toContain("mm.status = 'active'");
    expect(query.mock.calls[0][1][5]).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('derives network receivables and payables from persisted position direction', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { counterparty: 'KTG-FR', currency: 'XAF', corridor: 'FR-CG', receivable: '250', payable: '100' },
    ] });
    const repository = new FinanceReadRepository({ query } as any);

    await expect(repository.getNetworkPosition('KTG-CG')).resolves.toEqual({
      legal_entity: 'KTG-CG',
      totalReceivable: 250,
      totalPayable: 100,
      net: 150,
      counterpartyBreakdown: [{
        counterparty: 'KTG-FR', currency: 'XAF', corridor: 'FR-CG', receivable: 250, payable: 100, net: 150,
      }],
    });
    expect(query.mock.calls[0][0]).toContain("CASE ip.direction WHEN 'A_TO_B' THEN b.code ELSE a.code END AS creditor");
  });

  it('derives entity financial positions from the ledger and open intercompany positions', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ currency: 'XAF', cash_balance: '500' }] });
    const repository = new FinanceReadRepository({ query } as any);

    await expect(repository.getEntityFinancialPosition('KTG-CG')).resolves.toEqual([
      { currency: 'XAF', cash_balance: '500' },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM currencies'), ['KTG-CG']);
    expect(query.mock.calls[0][0]).toContain("le.account_code IN ('1100', '2000', '401000'");
    expect(query.mock.calls[0][0]).toContain("ip.status IN ('OPEN', 'INCLUDED_IN_BATCH')");
  });

  it('derives active corridors from approved regulatory profiles', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new FinanceReadRepository({ query } as any);

    await repository.listActiveCorridors();
    expect(query.mock.calls[0][0]).toContain('FROM konektag.regulatory_profiles rp');
    expect(query.mock.calls[0][0]).toContain("rp.status = 'APPROVED'");
  });

  it('applies intercompany filters to entity joins rather than SELECT aliases', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new FinanceReadRepository({ query } as any);

    await repository.listIntercompany({ legalEntity: 'KTG-CG', counterparty: 'KTG-FR', debtor: 'KTG-FR' });

    const sql = query.mock.calls[0][0];
    expect(sql).toContain("CASE ip.direction WHEN 'A_TO_B' THEN b.code ELSE a.code END = $1");
    expect(sql).toContain('a.code = $2 OR b.code = $2');
    expect(sql).not.toContain('creditor.code');
  });

  it('returns the merchant dashboard summary contract with numeric values', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      today_gross: '100', today_commission: '5', today_net: '95',
      pending_net: '60', settled_net: '35', next_due_date: '2026-08-10',
    }] });
    const repository = new FinanceReadRepository({ query } as any);

    await expect(repository.summarizeMerchantSales('00000000-0000-0000-0000-000000000001')).resolves.toEqual({
      today: { gross: 100, commission: 5, net: 95 },
      toSettle: { net: 60 },
      settled: { net: 35 },
      nextDueDate: '2026-08-10',
    });
  });
});
