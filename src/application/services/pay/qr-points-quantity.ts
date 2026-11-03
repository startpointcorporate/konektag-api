import type { QrPayment } from '../../shared/core02/contracts.ts';
import type { PointsKValuation } from '../../../domain/points-k-valuation.ts';
import { PointsKValuationError, valuePointsK, verifyLocalPointsKValuation } from '../points-k-valuation-service.ts';

type Database = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export type PointsQuantityErrorCode =
  | 'SIGNED_QR_QUANTITY_MISMATCH'
  | 'SIGNED_QR_VALUATION_REFERENCE_INVALID'
  | 'POINTS_K_QUOTE_CHANGED'
  | 'EXPECTED_QUANTITY_K_REQUIRED';

export class PointsQuantityError extends Error {
  constructor(public readonly code: PointsQuantityErrorCode, public readonly quotedQuantityK?: number) { super(code); }
}

/**
 * A fixed QR freezes its valuation at issuance: the signed quantity must equal
 * the official valuation of the signed amount at issuedAt.
 */
export async function verifyFixedQrQuantity(db: Database, qr: QrPayment): Promise<PointsKValuation> {
  if (qr.variableAmount || qr.amount === undefined || qr.quantityK === undefined) {
    throw new PointsQuantityError('SIGNED_QR_QUANTITY_MISMATCH');
  }
  const valuedAt = new Date(qr.issuedAt * 1000);
  // A QR signed with the merchant's local reference is verified against that exact approved reference.
  if (qr.valuationProofHash) {
    try {
      return await verifyLocalPointsKValuation({ sourceCurrency: qr.currency, sourceAmountMinor: qr.amount, valuedAt,
        context: 'qr-fixed', quantityK: qr.quantityK, reference: { proofHash: qr.valuationProofHash } }, db);
    } catch (error) {
      if (error instanceof PointsKValuationError && error.code === 'LOCAL_POINTS_K_VALUATION_MISMATCH') throw new PointsQuantityError('SIGNED_QR_QUANTITY_MISMATCH');
      if (error instanceof PointsKValuationError && error.code.startsWith('POINTS_K_REFERENCE_')) throw new PointsQuantityError('SIGNED_QR_VALUATION_REFERENCE_INVALID');
      throw error;
    }
  }
  const valuation = await valuePointsK({
    sourceCurrency: qr.currency, sourceAmountMinor: qr.amount, valuedAt, context: 'qr-fixed',
  }, db);
  if (valuation.quantityK !== qr.quantityK) throw new PointsQuantityError('SIGNED_QR_QUANTITY_MISMATCH');
  return valuation;
}

/**
 * Server-authoritative Points K quantity debited for a payer-chosen amount.
 * The payer's displayed quote is a consent check only: any drift requires a
 * new confirmation and nothing is consumed.
 */
export async function valueConsentedAmount(db: Database, input: {
  currency: string; amountMinor: number; expectedQuantityK: unknown; context: string;
}): Promise<PointsKValuation> {
  const expected = Number(input.expectedQuantityK);
  if (input.expectedQuantityK === undefined || input.expectedQuantityK === null
    || !Number.isSafeInteger(expected) || expected <= 0) {
    throw new PointsQuantityError('EXPECTED_QUANTITY_K_REQUIRED');
  }
  const valuation = await valuePointsK({
    sourceCurrency: input.currency, sourceAmountMinor: input.amountMinor, context: input.context,
  }, db);
  if (valuation.quantityK !== expected) throw new PointsQuantityError('POINTS_K_QUOTE_CHANGED', valuation.quantityK);
  return valuation;
}

/** Resolves the Points K quantity a signed QR payment debits. */
export async function resolveQrPaymentQuantity(db: Database, qr: QrPayment, payment: {
  amountMinor: number; expectedQuantityK?: unknown;
}): Promise<PointsKValuation> {
  if (!qr.variableAmount) return verifyFixedQrQuantity(db, qr);
  return valueConsentedAmount(db, {
    currency: qr.currency, amountMinor: payment.amountMinor,
    expectedQuantityK: payment.expectedQuantityK, context: 'qr-variable',
  });
}
