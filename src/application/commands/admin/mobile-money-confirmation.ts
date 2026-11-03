import { createHash } from 'node:crypto';

export interface MobileMoneyConfirmationInput {
  provider: string;
  country: string;
  operator: string;
  providerReference: string;
  amount: number;
  currency: string;
  receivedAt: string;
  maskedSender: string;
  evidenceRef?: string;
  note?: string;
}

export class MobileMoneyConfirmationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function stringField(value: unknown, field: string, max: number, pattern: RegExp): string {
  if (typeof value !== 'string') throw new MobileMoneyConfirmationError(`Invalid ${field}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !pattern.test(normalized)) {
    throw new MobileMoneyConfirmationError(`Invalid ${field}`);
  }
  return normalized;
}

export function parseMobileMoneyConfirmation(body: unknown): MobileMoneyConfirmationInput {
  if (!body || typeof body !== 'object') throw new MobileMoneyConfirmationError('Invalid request body');
  const value = body as Record<string, unknown>;
  const provider = stringField(value.provider, 'provider', 50, /^[A-Za-z0-9_-]+$/).toUpperCase();
  const country = stringField(value.country, 'country', 2, /^[A-Za-z]{2}$/).toUpperCase();
  const operator = value.operator === undefined || value.operator === null || value.operator === ''
    ? provider
    : stringField(value.operator, 'operator', 50, /^[A-Za-z0-9_-]+$/).toUpperCase();
  const providerReference = stringField(value.providerReference, 'providerReference', 255, /^[A-Za-z0-9._/-]+$/);
  const currency = stringField(value.currency, 'currency', 3, /^[A-Za-z]{3}$/).toUpperCase();
  const amount = Number(value.amount);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100_000_000) {
    throw new MobileMoneyConfirmationError('Invalid amount');
  }
  if (typeof value.receivedAt !== 'string' || Number.isNaN(Date.parse(value.receivedAt))) {
    throw new MobileMoneyConfirmationError('Invalid receivedAt');
  }
  const receivedAt = new Date(value.receivedAt);
  if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw new MobileMoneyConfirmationError('receivedAt cannot be in the future');
  if (typeof value.maskedSender !== 'string') throw new MobileMoneyConfirmationError('Invalid maskedSender');
  const maskedSender = value.maskedSender.trim();
  // Display only the last four digits. Country prefixes or a full number are never retained.
  if (!/^[- ()*.0-9]+$/.test(maskedSender) || !maskedSender.includes('*') || (maskedSender.match(/\d/g) || []).length > 4) {
    throw new MobileMoneyConfirmationError('maskedSender must be a masked display with at most four visible digits');
  }
  const evidenceRef = value.evidenceRef === undefined || value.evidenceRef === null || value.evidenceRef === ''
    ? undefined
    : stringField(value.evidenceRef, 'evidenceRef', 255, /^[A-Za-z0-9._:/-]+$/);
  const note = value.note === undefined || value.note === null || value.note === ''
    ? undefined
    : stringField(value.note, 'note', 1_000, /^[\s\S]+$/);

  return { provider, country, operator, providerReference, amount, currency, receivedAt: receivedAt.toISOString(), maskedSender, evidenceRef, note };
}

type DatabaseClient = { query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };

interface ReceiptRow {
  id: string;
  provider: string;
  country: string;
  operator: string;
  provider_reference: string;
  amount: number | string;
  currency: string;
  received_at: string | Date;
  masked_sender: string;
  evidence_hash: string | null;
  note: string | null;
}

export async function persistMobileMoneyReceipt(
  client: DatabaseClient,
  sourceType: 'recharge' | 'api_payment',
  sourceId: string,
  adminId: string,
  input: MobileMoneyConfirmationInput,
): Promise<{ id: string; existing: boolean }> {
  const evidenceHash = input.evidenceRef ? createHash('sha256').update(input.evidenceRef).digest('hex') : null;
  const { rows: existingRows } = await client.query<ReceiptRow>(
    `SELECT id, provider, country, operator, provider_reference, amount, currency, received_at,
            masked_sender, evidence_hash, note
     FROM konektag.mobile_money_receipts
     WHERE source_type = $1 AND source_id = $2`,
    [sourceType, sourceId],
  );
  const existing = existingRows[0];
  if (existing) {
    const same = existing.provider === input.provider && existing.country === input.country
      && existing.operator === input.operator && existing.provider_reference === input.providerReference
      && Number(existing.amount) === input.amount && existing.currency === input.currency
      && new Date(existing.received_at).toISOString() === input.receivedAt
      && existing.masked_sender === input.maskedSender && existing.evidence_hash === evidenceHash
      && existing.note === (input.note ?? null);
    if (!same) throw new MobileMoneyConfirmationError('A different receipt is already recorded for this source', 409);
    return { id: existing.id, existing: true };
  }

  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO konektag.mobile_money_receipts
       (source_type, source_id, provider, country, operator, provider_reference, amount, currency,
        received_at, masked_sender, evidence_reference, evidence_hash, note, verification_method, verified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'admin_manual', $14)
       RETURNING id`,
      [sourceType, sourceId, input.provider, input.country, input.operator, input.providerReference,
        input.amount, input.currency, input.receivedAt, input.maskedSender, input.evidenceRef ?? null,
        evidenceHash, input.note ?? null, adminId],
    );
    return { id: rows[0].id, existing: false };
  } catch (error: any) {
    if (error?.code === '23505') throw new MobileMoneyConfirmationError('Provider reference is already used by another receipt', 409);
    throw error;
  }
}
