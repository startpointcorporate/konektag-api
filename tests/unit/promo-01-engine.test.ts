import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/infrastructure/database/pool.ts',()=>({default:{query:vi.fn(),connect:vi.fn()}}));
import { calculatePromotionDiscounts } from '../../src/application/core-transaction-service.ts';
import type { PromotionSnapshot } from '../../src/application/promotion-service.ts';

const promo = (overrides: Partial<PromotionSnapshot> = {}): PromotionSnapshot => ({
  id: 'promo-1', merchantId: 'merchant-1', title: 'Promo', category: 'general',
  discountType: 'percentage', discountValue: 10, startDate: '2026-01-01T00:00:00.000Z',
  isActive: true, fingerprint: 'a'.repeat(64), ...overrides,
});

describe('PROMO-01 server discount calculation', () => {
  it('applies a percentage promotion to the eligible subtotal', () => {
    expect(calculatePromotionDiscounts([{ subtotalMinor: 1000 }], promo(), 'EUR')).toEqual([100]);
  });

  it('applies a fixed promotion only to matching categories', () => {
    expect(calculatePromotionDiscounts([
      { subtotalMinor: 1000, category: 'food' },
      { subtotalMinor: 500, category: 'hotel' },
    ], promo({ category: 'food', discountType: 'fixed', discountValue: 3 }), 'EUR')).toEqual([300, 0]);
  });

  it('never makes a discount negative or larger than the eligible subtotal', () => {
    expect(calculatePromotionDiscounts([{ subtotalMinor: 100 }], promo({ discountType: 'fixed', discountValue: 50 }), 'XAF')).toEqual([50]);
    expect(calculatePromotionDiscounts([{ subtotalMinor: 100 }], promo({ discountType: 'percentage', discountValue: 100 }), 'EUR')).toEqual([100]);
  });

  it('leaves an ineligible cart unchanged', () => {
    expect(calculatePromotionDiscounts([{ subtotalMinor: 100, category: 'food' }], promo({ category: 'hotel' }), 'EUR')).toEqual([0]);
  });
});
