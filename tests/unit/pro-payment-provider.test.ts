import { describe, expect, it } from 'vitest';
import { supportsProPaymentProvider } from '../../src/application/services/pay/pro-payment-provider.ts';

describe('Pro payment provider support', () => {
  it('keeps approved classic Checkout rails and rejects currencies their routes cannot collect', () => {
    expect(supportsProPaymentProvider({ provider: 'stripe', paymentMethod: 'card' }, 'EUR', 'FR')).toBe(true);
    expect(supportsProPaymentProvider({ provider: 'stripe', paymentMethod: 'card' }, 'XOF', 'CI')).toBe(true);
    expect(supportsProPaymentProvider({ provider: 'pawapay', paymentMethod: 'mobile_money' }, 'XAF', 'CG')).toBe(true);
    expect(supportsProPaymentProvider({ provider: 'pawapay', paymentMethod: 'mobile_money' }, 'CDF', 'CD')).toBe(false);
    expect(supportsProPaymentProvider({ provider: 'stripe', paymentMethod: 'card' }, 'XAF', 'CG')).toBe(false);
  });
});
