import { describe, expect, it } from 'vitest';
import { addProPeriod, proPrice, renewalOpensAt } from '../../src/application/services/subscription-pricing.ts';

describe('Pro tariff and calendar', () => {
  it('uses the same exact minor-unit price for display and checkout', () => {
    expect(proPrice('MONTHLY')).toEqual({ amountMinor: 8900, currency: 'EUR' });
    expect(proPrice('ANNUAL')).toEqual({ amountMinor: 101460, currency: 'EUR' });
  });
  it('adds complete calendar periods from the already-paid end', () => {
    expect(addProPeriod(new Date('2026-01-31T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addProPeriod(new Date('2026-09-17T00:00:00Z'), 'ANNUAL').toISOString()).toBe('2027-09-17T00:00:00.000Z');
    expect(addProPeriod(new Date('2028-02-29T00:00:00Z'), 'ANNUAL').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
  it('opens monthly five days and annual one calendar month before expiry', () => {
    expect(renewalOpensAt(new Date('2026-10-10T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(renewalOpensAt(new Date('2026-03-31T00:00:00Z'), 'ANNUAL').toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });
});
