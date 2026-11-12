import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pointsKValuationModule } from '../helpers/points-k-valuation-stub.ts';

vi.mock('../../src/application/services/points-k-valuation-service.ts', () => pointsKValuationModule);
vi.mock('../../src/application/services/pay/points-acquisition-service.ts', () => ({
  confirmPointsAcquisition: vi.fn(async () => ({ transactionId: 'local-tx', acquisitionId: 'local-acquisition' })),
}));
process.env.DATABASE_URL ??= 'postgres://localhost:5432/konektag_test';
const { apiPaymentCheckoutService } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');
const { confirmPointsAcquisition } = await import('../../src/application/services/pay/points-acquisition-service.ts');

describe('Points K settlement preserves the canonical money unit', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ['EUR', 1200, 'MINOR', 1200], ['USD', 1221, 'MINOR', 1221],
    ['XAF', 8567, 'MINOR', 8567], ['EUR', 12, 'MAJOR', 1200],
  ])('%s %s %s consumes the frozen valuation once', async (currency, subtotal, amountUnit, expectedMinor) => {
    const frozenQuantity=Math.max(1,Math.round(expectedMinor/100));
    const order = { id: 'order', target_user_id: 'user', beneficiary_type: 'NETWORK', beneficiary_party_id: null,
      currency, subtotal_amount: subtotal, amount_unit: amountUnit, settlement_legal_entity_id: 'entity',
      settlement_corridor_id: 'CG-CG', settlement_regulatory_profile_id: 'profile', settlement_rail: 'mobile_money',
      settlement_regulated_actor_id: 'actor', payment_country: 'CG', settlement_provider: 'pawapay',
      points_quantity:frozenQuantity,lot_value_minor:expectedMinor,acquisition_status:'pending' } as any;
    const db = { query: vi.fn(async () => ({ rows: [{ id: 'attempt', expected_amount: expectedMinor, provider: 'pawapay' }] })) } as any;
    await apiPaymentCheckoutService.confirmWalletRecharge(db, order, 'mobile_money', 'deposit', 'event');
    expect(pointsKValuationModule.valuePointsK).not.toHaveBeenCalled();
    expect(confirmPointsAcquisition).toHaveBeenCalledWith(db, expect.objectContaining({ pointsQuantity:frozenQuantity,
      lotValueMinor: expectedMinor, confirmedMinor: expectedMinor }));
  });
});
