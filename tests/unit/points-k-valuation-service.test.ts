import { describe, expect, it } from 'vitest';
import { quoteOnePointK, valuePointsK, verifyLocalPointsKValuation } from '../../src/application/services/points-k-valuation-service.ts';

const authority = {
  id: '00000000-0000-0000-0000-000000000001', rate: '0.0015', points_k_matrix_version: 7,
  valid_from: '2026-01-01T00:00:00.000Z', valid_to: '2027-01-01T00:00:00.000Z',
  points_k_approval_source: 'TEST_APPROVAL',
};
const db = (row: any) => ({ query: async () => ({ rows: row?.points_k_status === 'APPROVED' ? [row] : [] }) });

describe('Points K valuation authority', () => {
  it('keeps the fixed EUR parity and returns a proof', async () => {
    const result = await valuePointsK({ sourceCurrency: 'EUR', sourceAmountMinor: 1500 }, db({ ...authority, points_k_status: 'APPROVED', id: '00000000-0000-0000-0000-000000000002', rate: '1' }) as any);
    expect(result).toMatchObject({ sourceCurrency: 'EUR', eurAmountMinor: 1500, quantityK: 15, rate: '1', matrixVersion: 7 });
    expect(result.proofHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses only an approved direct source-to-EUR rate', async () => {
    const result = await valuePointsK({ sourceCurrency: 'XOF', sourceAmountMinor: 10000 }, db({ ...authority, points_k_status: 'APPROVED', rate: '0.0015' }) as any);
    expect(result).toMatchObject({ sourceCurrency: 'XOF', eurAmountMinor: 1500, quantityK: 15 });
  });

  it.each(['DRAFT', 'REVOKED', 'MISSING'])('rejects an unavailable authority state: %s', async status => {
    await expect(valuePointsK({ sourceCurrency: 'GNF', sourceAmountMinor: 100 }, db(status === 'MISSING' ? null : { ...authority, points_k_status: status }) as any))
      .rejects.toThrow('POINTS_K_RATE_NOT_APPROVED');
  });

  it('rounds K half-up and is deterministic', async () => {
    const input = { sourceCurrency: 'EUR', sourceAmountMinor: 1499 };
    const first = await valuePointsK(input, db({ ...authority, points_k_status: 'APPROVED', rate: '1' }) as any);
    const second = await valuePointsK(input, db({ ...authority, points_k_status: 'APPROVED', rate: '1' }) as any);
    expect(first.quantityK).toBe(15);
    expect(first.proofHash).toBe(second.proofHash);
  });

  it('does not use a local fallback for an uncovered currency', async () => {
    await expect(valuePointsK({ sourceCurrency: 'GNF', sourceAmountMinor: 1000 }, db(null) as any))
      .rejects.toThrow('POINTS_K_RATE_NOT_APPROVED');
  });

  it('returns the approved authority proof for the server display quote', async () => {
    const result = await quoteOnePointK('XOF', new Date('2026-06-01T00:00:00.000Z'), db({ ...authority, points_k_status: 'APPROVED', rate: '0.0015' }) as any);
    expect(result).toMatchObject({ pointCode: 'K', currency: 'XOF', sourceAmountMinor: 667, matrixVersion: 7, authorityId: authority.id });
    expect(result.proofHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('supports the two-decimal currencies present in the promoted front matrix', async () => {
    const result = await valuePointsK({ sourceCurrency: 'USD', sourceAmountMinor: 10000 }, db({ ...authority, points_k_status: 'APPROVED', rate: '0.922256098' }) as any);
    expect(result).toMatchObject({ sourceCurrency: 'USD', eurAmountMinor: 9223, quantityK: 92, rate: '0.922256098' });
  });

  describe('merchant-local valuation reference', () => {
    const approved = { ...authority, points_k_status: 'APPROVED', rate: '0.0015' };
    it('recomputes with the exact approved reference the merchant cached', async () => {
      const quote = await quoteOnePointK('XOF', new Date('2026-06-01T00:00:00Z'), db(approved) as any);
      const valuation = await verifyLocalPointsKValuation({ sourceCurrency: 'XOF', sourceAmountMinor: 10000, quantityK: 15,
        reference: { authorityId: quote.authorityId, matrixVersion: quote.matrixVersion, proofHash: quote.proofHash } }, db(approved) as any);
      expect(valuation).toMatchObject({ quantityK: 15, authorityId: authority.id, matrixVersion: 7 });
    });
    it('rejects a reference whose proof is not an approved reference', async () => {
      await expect(verifyLocalPointsKValuation({ sourceCurrency: 'XOF', sourceAmountMinor: 10000, quantityK: 15,
        reference: { proofHash: 'c'.repeat(64) } }, db(approved) as any)).rejects.toThrow('POINTS_K_REFERENCE_NOT_APPROVED');
    });
    it('rejects a merchant quantity that the reference does not produce', async () => {
      const quote = await quoteOnePointK('XOF', new Date('2026-06-01T00:00:00Z'), db(approved) as any);
      await expect(verifyLocalPointsKValuation({ sourceCurrency: 'XOF', sourceAmountMinor: 10000, quantityK: 16,
        reference: { proofHash: quote.proofHash } }, db(approved) as any)).rejects.toThrow('LOCAL_POINTS_K_VALUATION_MISMATCH');
    });
  });
});
