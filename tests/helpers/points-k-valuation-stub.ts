import { vi } from 'vitest';
import type { PointsKValuation } from '../../src/domain/points-k-valuation';

/** Deterministic official-valuation stand-in: 100 source minor units value 1 K. */
export function stubValuation(sourceCurrency: string, sourceAmountMinor: number): PointsKValuation {
  const quantityK = Math.max(1, Math.round(sourceAmountMinor / 100));
  return {
    sourceCurrency, sourceAmountMinor, rate: '1', eurAmountMinor: quantityK * 100, quantityK, matrixVersion: 1,
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z',
    authorityId: '00000000-0000-4000-8000-000000000001', approvalSource: 'test', proofHash: 'a'.repeat(64),
  };
}

/** Approved reference a merchant device cached from the stub authority. */
export const STUB_REFERENCE = { authorityId: '00000000-0000-4000-8000-000000000001', matrixVersion: 1, proofHash: 'b'.repeat(64) };

export class PointsKValuationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export const pointsKValuationModule = {
  PointsKValuationError,
  valuePointsK: vi.fn(async (input: { sourceCurrency: string; sourceAmountMinor: number }) =>
    stubValuation(input.sourceCurrency, input.sourceAmountMinor)),
  /** Accepts only the stub approved reference and the quantity it produces. */
  verifyLocalPointsKValuation: vi.fn(async (input: { sourceCurrency: string; sourceAmountMinor: number; quantityK: number;
    reference: { proofHash: string } }) => {
    const valuation = stubValuation(input.sourceCurrency, input.sourceAmountMinor);
    if (input.reference?.proofHash !== STUB_REFERENCE.proofHash) throw new PointsKValuationError('POINTS_K_REFERENCE_NOT_APPROVED');
    if (input.quantityK !== valuation.quantityK) throw new PointsKValuationError('LOCAL_POINTS_K_VALUATION_MISMATCH');
    return valuation;
  }),
};
