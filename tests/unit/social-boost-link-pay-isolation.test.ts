import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), lockQuery: vi.fn(), release: vi.fn(),
  list: vi.fn(), create: vi.fn(), submit: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.query, connect: mocks.connect },
}));
vi.mock('../../src/infrastructure/adapters/erpnext-adapter.ts', () => ({
  erpnext: { listAdvanced: mocks.list, create: mocks.create, submit: mocks.submit },
}));

import { markSocialBoostPaid } from '../../src/application/services/merchant-social-boost-service.ts';

describe('historical social Boost Link Pay behavior', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.KONEKTAG_BOOST_ERP_CUSTOMERS = JSON.stringify({ FR: 'Boost customer' });
    mocks.connect.mockResolvedValue({ query: mocks.lockQuery, release: mocks.release });
    mocks.lockQuery.mockResolvedValue({ rows: [] });
  });

  it('keeps recording and submitting the historical Boost ERP sale', async () => {
    const paid = { id: 'boost-1', paid_at: '2026-11-09T15:00:00.000Z' };
    const boost = { id: 'boost-1', country: 'FR', currency: 'EUR', pricing_snapshot: [
      { item_code: 'KTG-BOOST-FACEBOOK-FR', cpm_minor: 100, budget_minor: 1000, billing_company: 'Konektag France' },
    ] };
    const synced = { ...boost, erp_invoice: 'INV-1' };
    mocks.query
      .mockResolvedValueOnce({ rows: [paid] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [boost] })
      .mockResolvedValueOnce({ rows: [{ frappe_company: 'Konektag France', country_code: 'FR' }] })
      .mockResolvedValueOnce({ rows: [synced] });
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ name: 'INV-1', docstatus: 0 });
    mocks.submit.mockResolvedValue({ name: 'INV-1', docstatus: 1 });

    await expect(markSocialBoostPaid('boost-payment-reference')).resolves.toBe(synced);

    expect(mocks.create).toHaveBeenCalledWith('Sales Invoice', expect.objectContaining({ po_no: 'KONEKTAG-BOOST-boost-1' }));
    expect(mocks.submit).toHaveBeenCalledWith('Sales Invoice', 'INV-1');
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
