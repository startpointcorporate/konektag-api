import { requireFinancialAccountActive } from '../wallet-integrity-service.ts';
import type { PoolClient } from 'pg';

type Database = Pick<PoolClient, 'query'>;
export type PointsReservationState = 'active' | 'confirmed' | 'released' | 'expired';
export interface PointsReservation {
  id: string;
  partyId: string;
  quantity: number;
  state: PointsReservationState;
  expiresAt: Date;
}

function reservation(row: any): PointsReservation {
  return { id: row.id, partyId: row.payer_party_id, quantity: Number(row.amount),
    state: row.lifecycle === 'captured' ? 'confirmed' : row.lifecycle,
    expiresAt: new Date(row.expires_at) };
}

// All mutation methods require the caller's transaction. Financial effects,
// request validation and the monetary outbox must commit with this transaction.
export async function lockPointsOwner(db: Database, partyId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`points-wallet:${partyId}`]);
}

export async function reservePoints(db: Database, input: {
  partyId: string; operationKey: string; quantity: number; expiresAt: Date; paymentOrderId?: string; authorizationId?: string;
}): Promise<PointsReservation> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || !input.operationKey.trim()
    || !Number.isFinite(input.expiresAt.getTime())) throw new Error('POINTS_RESERVATION_INVALID');
  await lockPointsOwner(db, input.partyId);
  const { rows: [existing] } = await db.query(
    'SELECT * FROM konektag.api_payment_wallet_reservations WHERE operation_key = $1 OR payment_order_id = $2 FOR UPDATE',
    [input.operationKey, input.paymentOrderId ?? null]);
  if (existing) {
    if (existing.payer_party_id !== input.partyId || Number(existing.amount) !== input.quantity
      || existing.currency !== 'K') throw new Error('POINTS_RESERVATION_IDEMPOTENCY_CONFLICT');
    return reservation(existing);
  }
  await requireFinancialAccountActive(db,input.partyId);
  // The database trigger checks available funds while holding the same lock.
  const { rows: [created] } = await db.query(
    `INSERT INTO konektag.api_payment_wallet_reservations
      (operation_key, payer_party_id, amount, currency, expires_at, payment_order_id, authorization_id)
     VALUES ($1, $2, $3, 'K', $4, $5, $6) RETURNING *`,
    [input.operationKey, input.partyId, input.quantity, input.expiresAt, input.paymentOrderId ?? null, input.authorizationId ?? null]);
  return reservation(created);
}

export async function releasePoints(db: Database, partyId: string, id: string): Promise<PointsReservation> {
  await lockPointsOwner(db, partyId);
  const { rows: [row] } = await db.query(
    `SELECT * FROM konektag.api_payment_wallet_reservations
     WHERE id = $1 AND payer_party_id = $2 AND currency = 'K' FOR UPDATE`, [id, partyId]);
  if (!row) throw new Error('POINTS_RESERVATION_NOT_FOUND');
  if (row.lifecycle === 'captured') throw new Error('POINTS_RESERVATION_ALREADY_CONFIRMED');
  if (row.lifecycle !== 'active') return reservation(row);
  const { rows: [released] } = await db.query(
    `UPDATE konektag.api_payment_wallet_reservations
     SET lifecycle = CASE WHEN expires_at <= statement_timestamp() THEN 'expired' ELSE 'released' END,
       released_at = now(), release_reason = 'operation_cancelled', updated_at = now(), version = version + 1
     WHERE id = $1 RETURNING *`, [id]);
  return reservation(released);
}

export async function confirmPointsReservation(db: Database, input: {
  partyId: string; reservationId: string; consumptionTransactionId: string;
}): Promise<PointsReservation> {
  await lockPointsOwner(db, input.partyId);
  const { rows: [row] } = await db.query(
    `SELECT *, expires_at <= statement_timestamp() AS is_expired
     FROM konektag.api_payment_wallet_reservations
     WHERE id = $1 AND payer_party_id = $2 AND currency = 'K' FOR UPDATE`,
    [input.reservationId, input.partyId]);
  if (!row) throw new Error('POINTS_RESERVATION_NOT_FOUND');
  if (row.lifecycle === 'captured' && row.consumption_transaction_id === input.consumptionTransactionId) return reservation(row);
  if (row.lifecycle !== 'active' || row.is_expired) throw new Error('POINTS_RESERVATION_NOT_ACTIVE');
  const { rows: [proof] } = await db.query(
    `SELECT count(*) = 2 AND bool_and(e.currency = 'K' AND e.amount = $3
       AND e.gl_scope = 'GLOBAL_USER_GL' AND
       ((e.account_code = '1000' AND e.entry_side = 'debit' AND e.party_id = $2)
        OR (e.account_code = 'K_ISSUANCE' AND e.entry_side = 'credit' AND e.party_id IS NULL))) AS valid
     FROM konektag.ledger_entries e JOIN konektag.financial_transactions t ON t.id = e.transaction_id
     WHERE t.id = $1 AND t.currency = 'K' AND t.status = 'completed'`,
    [input.consumptionTransactionId, input.partyId, row.amount]);
  if (!proof?.valid) throw new Error('POINTS_CONSUMPTION_PROOF_REQUIRED');
  const { rows: [confirmed] } = await db.query(
    `UPDATE konektag.api_payment_wallet_reservations
     SET lifecycle = 'captured', consumption_transaction_id = $2, captured_at = now(),
       updated_at = now(), version = version + 1 WHERE id = $1 RETURNING *`,
    [row.id, input.consumptionTransactionId]);
  return reservation(confirmed);
}

export async function expirePointsReservations(db: Database): Promise<number> {
  // Lock owners before rows, as reservation and confirmation do. Taking row
  // locks first would deadlock with a simultaneous confirmation by that owner.
  const { rows: owners } = await db.query(
    `SELECT DISTINCT payer_party_id FROM konektag.api_payment_wallet_reservations
     WHERE currency = 'K' AND lifecycle = 'active' AND expires_at <= statement_timestamp()
     ORDER BY payer_party_id LIMIT 100`);
  for (const owner of owners) await lockPointsOwner(db, owner.payer_party_id);
  const { rowCount } = await db.query(
    `WITH due AS (
       SELECT id FROM konektag.api_payment_wallet_reservations
       WHERE currency = 'K' AND lifecycle = 'active' AND expires_at <= statement_timestamp()
         AND payer_party_id = ANY($1::uuid[])
       ORDER BY payer_party_id, id LIMIT 100 FOR UPDATE SKIP LOCKED
     ) UPDATE konektag.api_payment_wallet_reservations r
       SET lifecycle = 'expired', released_at = now(), release_reason = 'reservation_expired',
         updated_at = now(), version = version + 1
       FROM due WHERE r.id = due.id`, [owners.map(owner => owner.payer_party_id)]);
  return rowCount ?? 0;
}

