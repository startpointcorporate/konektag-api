import { createHash } from 'node:crypto';
import { convertMinor, minorDigits } from './pay/money-unit.ts';
import { PointsKValuationSchema, type PointsKValuation } from '../../domain/points-k-valuation.ts';

type Database = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export class PointsKValuationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

/** Official Points K parity: one K is worth this many EUR minor units. */
export const POINTS_K_EUR_MINOR_PER_K = 100;
/** Identifies the parity snapshot recorded with every consumed K value. */
export const POINTS_K_EUR_PARITY_VERSION = 'K_EUR_PARITY_1';

function quantityFromEurMinor(eurAmountMinor: number): number {
  // K is an integer unit valued at the official parity. Half-up is
  // deterministic and uses integer arithmetic; values rounding to zero fail.
  const parity = BigInt(POINTS_K_EUR_MINOR_PER_K);
  const rounded = (BigInt(eurAmountMinor) + parity / 2n) / parity;
  if (rounded < 1n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PointsKValuationError('POINTS_K_AMOUNT_TOO_SMALL');
  }
  return Number(rounded);
}

/**
 * Monetary value of a consumed Points K quantity, snapshotted from the official
 * parity. It is the only cashback base; a transaction amount never is.
 */
export function valueConsumedPointsK(quantityK: number): { amount: string; currency: 'EUR'; version: string } {
  if (!Number.isSafeInteger(quantityK) || quantityK <= 0) throw new PointsKValuationError('POINTS_K_QUANTITY_INVALID');
  const minor = BigInt(quantityK) * BigInt(POINTS_K_EUR_MINOR_PER_K);
  const amount = `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
  return { amount, currency: 'EUR', version: POINTS_K_EUR_PARITY_VERSION };
}

export interface PointsKValuationInput {
  sourceCurrency: string;
  sourceAmountMinor: number;
  valuedAt?: Date;
  context?: string;
}

async function defaultDatabase(): Promise<Database> {
  return (await import('../../infrastructure/database/pool.ts')).default;
}

type AuthorityRow = {
  id: string;
  rate: string;
  points_k_matrix_version: number;
  valid_from: string | Date;
  valid_to: string | Date;
  points_k_approval_source: string;
};

async function approvedAuthority(sourceCurrency: string, valuedAt: Date, db: Database): Promise<AuthorityRow> {
  const { rows } = await db.query(`
    SELECT id, rate::text AS rate, points_k_matrix_version, valid_from, valid_to,
           points_k_approval_source
    FROM konektag.exchange_rates
    WHERE from_currency=$1 AND to_currency='EUR'
      AND points_k_status='APPROVED'
      AND valid_from <= $2 AND valid_to > $2
    ORDER BY points_k_matrix_version DESC, valid_from DESC, id DESC
    LIMIT 1`, [sourceCurrency, valuedAt]);
  if (!rows[0]) throw new PointsKValuationError('POINTS_K_RATE_NOT_APPROVED');
  return rows[0] as AuthorityRow;
}

function proofHash(proof: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(proof)).digest('hex');
}

export async function valuePointsK(input: PointsKValuationInput, db?: Database): Promise<PointsKValuation> {
  const sourceCurrency = input.sourceCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(sourceCurrency)) throw new PointsKValuationError('POINTS_K_CURRENCY_INVALID');
  if (!Number.isSafeInteger(input.sourceAmountMinor) || input.sourceAmountMinor <= 0) {
    throw new PointsKValuationError('POINTS_K_AMOUNT_INVALID');
  }
  try { minorDigits(sourceCurrency); } catch { throw new PointsKValuationError('POINTS_K_CURRENCY_UNSUPPORTED'); }
  const valuedAt = input.valuedAt ?? new Date();
  if (!Number.isFinite(valuedAt.getTime())) throw new PointsKValuationError('POINTS_K_DATE_INVALID');

  const authority = await approvedAuthority(sourceCurrency, valuedAt, db ?? await defaultDatabase());
  return buildValuation(sourceCurrency, input.sourceAmountMinor, authority);
}

function buildValuation(sourceCurrency: string, sourceAmountMinor: number, authority: AuthorityRow): PointsKValuation {
  const eurAmountMinor = convertMinor(sourceAmountMinor, sourceCurrency, 'EUR', String(authority.rate));
  const quantityK = quantityFromEurMinor(eurAmountMinor);
  const result = {
    sourceCurrency,
    sourceAmountMinor,
    rate: String(authority.rate),
    eurAmountMinor,
    quantityK,
    matrixVersion: Number(authority.points_k_matrix_version),
    validFrom: new Date(authority.valid_from).toISOString(),
    validTo: new Date(authority.valid_to).toISOString(),
    authorityId: String(authority.id),
    approvalSource: String(authority.points_k_approval_source),
    proofHash: '',
  } satisfies Omit<PointsKValuation, 'proofHash'> & { proofHash: string };
  const { proofHash: _, ...proof } = result;
  result.proofHash = proofHash(proof);
  return PointsKValuationSchema.parse(result);
}

export async function quoteOnePointK(sourceCurrencyInput: string, valuedAt = new Date(), db?: Database) {
  const sourceCurrency = sourceCurrencyInput.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(sourceCurrency)) throw new PointsKValuationError('POINTS_K_CURRENCY_INVALID');
  try { minorDigits(sourceCurrency); } catch { throw new PointsKValuationError('POINTS_K_CURRENCY_UNSUPPORTED'); }
  if (!Number.isFinite(valuedAt.getTime())) throw new PointsKValuationError('POINTS_K_DATE_INVALID');

  const authority = await approvedAuthority(sourceCurrency, valuedAt, db ?? await defaultDatabase());
  const proof = quoteProof(sourceCurrency, authority);
  const pointValue = proof.sourceAmountMinor / (10 ** minorDigits(sourceCurrency));
  return {
    pointCode: 'K',
    currency: sourceCurrency,
    pointValue,
    ...proof,
    proofHash: proofHash(proof),
    display: `1 point K = ${pointValue} ${sourceCurrency}`,
  };
}

/** Proof of the approved reference a merchant device caches for its local conversion (one K). */
function quoteProof(sourceCurrency: string, authority: AuthorityRow) {
  return {
    sourceCurrency,
    sourceAmountMinor: convertMinor(100, 'EUR', sourceCurrency, String(authority.rate), true),
    rate: String(authority.rate),
    matrixVersion: Number(authority.points_k_matrix_version),
    validFrom: new Date(authority.valid_from).toISOString(),
    validTo: new Date(authority.valid_to).toISOString(),
    authorityId: String(authority.id),
    approvalSource: String(authority.points_k_approval_source),
  };
}

export interface PointsKReference {
  proofHash: string;
  authorityId?: string;
  matrixVersion?: number;
}

/**
 * Verifies the approved reference a merchant used for its local conversion and values the amount
 * with that same reference. The server checks the merchant's calculation; it is not its origin.
 */
export async function verifyLocalPointsKValuation(input: PointsKValuationInput & { reference: PointsKReference; quantityK: number },
  db?: Database): Promise<PointsKValuation> {
  const sourceCurrency = input.sourceCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(sourceCurrency)) throw new PointsKValuationError('POINTS_K_CURRENCY_INVALID');
  if (!Number.isSafeInteger(input.sourceAmountMinor) || input.sourceAmountMinor <= 0) {
    throw new PointsKValuationError('POINTS_K_AMOUNT_INVALID');
  }
  try { minorDigits(sourceCurrency); } catch { throw new PointsKValuationError('POINTS_K_CURRENCY_UNSUPPORTED'); }
  if (!/^[a-f0-9]{64}$/.test(String(input.reference?.proofHash ?? ''))) throw new PointsKValuationError('POINTS_K_REFERENCE_INVALID');
  const valuedAt = input.valuedAt ?? new Date();
  if (!Number.isFinite(valuedAt.getTime())) throw new PointsKValuationError('POINTS_K_DATE_INVALID');
  const { rows } = await (db ?? await defaultDatabase()).query(`
    SELECT id, rate::text AS rate, points_k_matrix_version, valid_from, valid_to,
           points_k_approval_source
    FROM konektag.exchange_rates
    WHERE from_currency=$1 AND to_currency='EUR'
      AND points_k_status='APPROVED'
      AND valid_from <= $2 AND valid_to > $2
      AND ($3::text IS NULL OR id::text=$3::text)
      AND ($4::int IS NULL OR points_k_matrix_version=$4::int)`,
    [sourceCurrency, valuedAt, input.reference.authorityId ?? null, input.reference.matrixVersion ?? null]);
  const authority = (rows as AuthorityRow[]).find((row) => proofHash(quoteProof(sourceCurrency, row)) === input.reference.proofHash);
  if (!authority) throw new PointsKValuationError('POINTS_K_REFERENCE_NOT_APPROVED');
  const valuation = buildValuation(sourceCurrency, input.sourceAmountMinor, authority);
  if (valuation.quantityK !== input.quantityK) throw new PointsKValuationError('LOCAL_POINTS_K_VALUATION_MISMATCH');
  return valuation;
}
