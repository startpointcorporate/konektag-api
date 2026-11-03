import { describe, it, expect } from 'vitest';
import { toProviderMinor, formatEurMinor, convertEurMinor, convertMinor, minorDecimal } from '../../src/application/services/pay/money-unit.ts';
process.env.DATABASE_URL ??= 'postgres://localhost:5432/konektag_test';
const { toStripeAmount } = await import('../../src/application/services/pay/api-payment-checkout-service.ts');

describe('toProviderMinor', () => {
    it('converts 8900 MINOR EUR to 8900 Stripe', () => {
        expect(toProviderMinor(8900, 'EUR', 'MINOR')).toBe(8900);
    });

    it('converts 101460 MINOR EUR to 101460', () => {
        expect(toProviderMinor(101460, 'EUR', 'MINOR')).toBe(101460);
    });

    it('converts 89 MAJOR EUR to 8900', () => {
        expect(toProviderMinor(89, 'EUR', 'MAJOR')).toBe(8900);
    });

    it('rejects floating amount', () => {
        expect(() => toProviderMinor(100.5, 'EUR', 'MINOR')).toThrow();
    });

    it('rejects MINOR with non-EUR currency', () => {
        expect(() => toProviderMinor(100, 'USD', 'MINOR')).toThrow();
    });
});

describe('Pro Checkout Stripe boundary', () => {
  it('charges exact EUR cents without multiplying a minor amount again', () => {
    expect(toStripeAmount('EUR', 8900, 'MINOR')).toBe(8900);
    expect(toStripeAmount('EUR', 101460, 'MINOR')).toBe(101460);
    expect(toStripeAmount('EUR', 89, 'MAJOR')).toBe(8900);
  });
  it('rejects minor units for a currency without this contract', () => {
    expect(() => toStripeAmount('XAF', 101460, 'MINOR')).toThrow();
  });
});

describe('formatEurMinor', () => {
    it('formats 8900 minor as 89,00 EUR', () => {
        expect(formatEurMinor(8900)).toBe('89,00 EUR');
    });

    it('formats 101460 minor as 1 014,60 EUR', () => {
        expect(formatEurMinor(101460)).toBe('1 014,60 EUR');
    });
});

describe('Pro local-currency quote', () => {
  it('converts exact EUR cents to zero-decimal XAF with integer arithmetic', () => {
    expect(convertEurMinor(8900, 'XAF', '655.957')).toBe(58380);
    expect(convertEurMinor(101460, 'XAF', '655.957')).toBe(665534);
  });
  it('converts a local ledger amount back to an EUR decimal string', () => {
    expect(minorDecimal(convertMinor(58380, 'XAF', 'EUR', '655.957', true), 'EUR')).toBe('89.00');
  });
});
