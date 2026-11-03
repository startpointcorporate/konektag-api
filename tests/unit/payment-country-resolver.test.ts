import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: {} }));
import { PaymentCountryResolver } from '../../src/application/services/pay/payment-country-resolver.ts';

function resolver(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { resolver: new PaymentCountryResolver({ query }), query };
}

describe('PaymentCountryResolver', () => {
  it.each([['FR', 'FR'], ['BE', 'FR'], ['LU', 'FR']])('resolves explicit master data %s -> %s', async (detectedCountry, paymentCountry) => {
    await expect(resolver([{ payment_country: paymentCountry }]).resolver.resolve(detectedCountry)).resolves.toEqual({ detectedCountry, paymentCountry });
  });

  it('normalizes lowercase detected countries', async () => {
    await expect(resolver([{ payment_country: 'FR' }]).resolver.resolve('be')).resolves.toEqual({ detectedCountry: 'BE', paymentCountry: 'FR' });
  });

  it('rejects invalid countries', async () => {
    await expect(resolver([]).resolver.resolve('BEL')).rejects.toMatchObject({ code: 'PAYMENT_COUNTRY_INVALID' });
  });

  it('filters inactive, expired, and future mappings in SQL and fails when no eligible mapping remains', async () => {
    const subject = resolver([]);
    await expect(subject.resolver.resolve('BE')).rejects.toMatchObject({ code: 'PAYMENT_COUNTRY_MAPPING_NOT_FOUND' });
    const sql = subject.query.mock.calls[0][0];
    expect(sql).toContain("status = 'ACTIVE'");
    expect(sql).toContain('valid_from <= CURRENT_DATE');
    expect(sql).toContain('valid_until IS NULL OR valid_until >= CURRENT_DATE');
  });

  it('fails closed if inconsistent master data returns multiple applicable mappings', async () => {
    await expect(resolver([{ payment_country: 'FR' }, { payment_country: 'CG' }]).resolver.resolve('BE')).rejects.toMatchObject({ code: 'PAYMENT_COUNTRY_MAPPING_AMBIGUOUS' });
  });
});
