import { describe, expect, it, vi } from 'vitest';
import {
  currencyForCountry,
  requireCanonicalCurrency,
  resolveLegalEntityCurrency,
  resolveMerchantOperationCurrency,
  resolveUserOperationCurrency,
} from '../../src/application/services/operation-currency-service.ts';

describe('operation currency contract', () => {
  it('maps only approved countries without an XOF fallback', () => {
    expect(currencyForCountry('FR')).toBe('EUR');
    expect(currencyForCountry('cg')).toBe('XAF');
    expect(currencyForCountry('CI')).toBe('XOF');
    expect(() => currencyForCountry('ZZ')).toThrow('COUNTRY_UNSUPPORTED');
    expect(() => currencyForCountry(undefined)).toThrow('COUNTRY_REQUIRED');
  });

  it('rejects a caller currency that differs from the country currency', () => {
    expect(requireCanonicalCurrency('CG', 'XAF')).toBe('XAF');
    expect(() => requireCanonicalCurrency('CG', 'XOF')).toThrow('OPERATION_CURRENCY_MISMATCH');
  });

  it('derives personal operation currency from the user country', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ country: 'FR' }] }) };
    await expect(resolveUserOperationCurrency(client, 'user-1')).resolves.toEqual({ country: 'FR', currency: 'EUR' });
    expect(client.query.mock.calls[0][0]).not.toContain('legal_entities');
  });

  it('derives merchant operation currency from merchant country without a Legal Entity', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ merchant_country: 'CG' }] }) };
    await expect(resolveMerchantOperationCurrency(client, 'merchant-1')).resolves.toEqual({ country: 'CG', currency: 'XAF' });
    expect(client.query.mock.calls[0][0]).not.toContain('legal_entities');
  });

  it('rejects a noncanonical legal entity base currency', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ country_code: 'CG', base_currency: 'XOF' }] }) };
    await expect(resolveLegalEntityCurrency(client, 'entity-1')).rejects.toThrow('LEGAL_ENTITY_CURRENCY_MISMATCH');
  });
});
