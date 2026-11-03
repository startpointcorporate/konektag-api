import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), kyb: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: {} }));
vi.mock('../../src/application/services/merchant-kyb-service.ts', () => ({
  MerchantKybService: class { requireMerchantApproved = mocks.kyb; },
}));
vi.mock('../../src/application/services/financial-operation-service.ts', () => ({
  FinancialOperationService: class { execute = mocks.execute; },
}));
vi.mock('../../src/application/services/pay/points-wallet-service.ts', () => ({
  resolvePointsOwner: vi.fn().mockResolvedValue('party-1'),
  consumeReservedPoints: vi.fn().mockResolvedValue('k-tx-1'),
}));
vi.mock('../../src/application/services/pay/points-reservation-service.ts', () => ({
  lockPointsOwner: vi.fn().mockResolvedValue(undefined),
  reservePoints: vi.fn().mockResolvedValue({ id: 'hold-1' }),
}));
vi.mock('../../src/application/services/pay/points-benefits-service.ts', () => ({
  recordMerchantPointsConsumption: vi.fn().mockResolvedValue(undefined),
}));

import { consumptionService } from '../../src/application/services/consumption-service.ts';

describe('ConsumptionService merchant sale accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.kyb.mockResolvedValue({ approved: true });
    mocks.execute.mockResolvedValue({ success: true, financialTransactionId: 'tx-1' });
  });

  it('records the commercial gross with zero payer fee and defers merchant commission to settlement', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ country: 'CG', settlement_network: null,
        legal_entity_id: 'entity-cg', legal_entity_code: 'KTG-CG' }] })
      .mockResolvedValueOnce({ rows: [{ country: 'CG', keycloak_id: 'kc-payer' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'profile-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'sale-1' }] });

    const result = await consumptionService.consumeAtMerchant({
      idempotencyKey: 'consume-1', userId: 'payer-1', merchantProfileId: 'merchant-1',
      amount: 100, quantityK: 100, currency: 'XAF', merchantSaleRef: 'SALE-1', rail: 'qr', paymentCountry: 'CG',
    }, { query: mocks.query } as any);

    expect(result.success).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => /legal_entities|merchant_payment_commission_rules|konektag_revenue_attributions/.test(sql))).toBe(false);
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      amount: 100,
      entries: [
        expect.objectContaining({ accountCode: '8000', side: 'debit', amount: 100 }),
        expect.objectContaining({ accountCode: '2000', side: 'credit', amount: 100 }),
      ],
    }));
    const saleInsert = mocks.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO konektag.merchant_sales'));
    expect(saleInsert?.[1]).toEqual(['SALE-1', 'merchant-1', null, 'tx-1', 100, 100, 0, 0, 'XAF']);
  });
});
