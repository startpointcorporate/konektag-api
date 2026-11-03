import pool from '../infrastructure/database/pool.ts';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { assertMoney } from './services/pay/money-unit.ts';
import type { OfflineSyncState } from '../domain/core-offline.ts';

interface ReferenceRate { rate: string; rateId: string | null; inverse: boolean; convertedAt: Date }
export async function serverEurMinor(client: PoolClient, amountMinor: number, currency: string,
  reference: Pick<ReferenceRate, 'rate' | 'inverse'>): Promise<number> {
  const { rows: [row] } = await client.query<{ amount: string }>(
    `SELECT konektag.core_convert_to_eur_minor($1,$2,$3,$4)::text AS amount`,
    [amountMinor, currency, reference.rate, reference.inverse]);
  const amount = Number(row.amount);
  if (!Number.isSafeInteger(amount)) throw new Error('AMOUNT_OUT_OF_RANGE');
  return amount;
}
export async function serverReferenceRate(client: PoolClient, currency: string): Promise<ReferenceRate> {
  if (currency === 'EUR') {
    const { rows: [row] } = await client.query<{ converted_at: Date }>(`SELECT now() AS converted_at`);
    return { rate: '1', rateId: null, inverse: false, convertedAt: row.converted_at };
  }
  const { rows: [row] } = await client.query<{ id: string; rate: string; inverse: boolean; converted_at: Date }>(
    `SELECT id, rate::text AS rate, from_currency='EUR' AS inverse, now() AS converted_at
     FROM konektag.exchange_rates
     WHERE ((from_currency=$1 AND to_currency='EUR') OR (from_currency='EUR' AND to_currency=$1))
       AND valid_from<=now() AND valid_to>now()
     ORDER BY (from_currency=$1) DESC, valid_from DESC, id DESC LIMIT 1 FOR SHARE`, [currency]);
  if (!row) throw new Error('OFFLINE_REFERENCE_RATE_MISSING');
  return { rate: row.rate, rateId: row.id, inverse: row.inverse, convertedAt: row.converted_at };
}

/** Server-only decision; clients never provide a converted amount or FX rate. */
export async function createOfflineAuthorization(input: {
  deviceId: string; ownerUserId: string; currency: string; maximumCount: number;
  maximumTotalMinor: number; maximumSingleMinor: number; durationHours: number; decisionVersion: number;
}, transactionClient?: PoolClient): Promise<string> {
  if (!Number.isSafeInteger(input.maximumCount) || input.maximumCount < 1 || input.maximumCount > 10 ||
      !Number.isSafeInteger(input.maximumTotalMinor) || input.maximumTotalMinor <= 0 ||
      !Number.isSafeInteger(input.maximumSingleMinor) || input.maximumSingleMinor <= 0 ||
      input.maximumSingleMinor > input.maximumTotalMinor ||
      !Number.isInteger(input.durationHours) || input.durationHours < 1 || input.durationHours > 24 ||
      !Number.isSafeInteger(input.decisionVersion) || input.decisionVersion < 1) throw new Error('OFFLINE_AUTHORIZATION_LIMIT');
  assertMoney({ amountMinor: input.maximumTotalMinor, currency: input.currency });
  const client = transactionClient ?? await pool.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const device = await client.query(`SELECT 1 FROM konektag.core_offline_devices
      WHERE id=$1 AND owner_user_id=$2 AND state='ACTIVE' FOR UPDATE`, [input.deviceId, input.ownerUserId]);
    if (!device.rowCount) throw new Error('OFFLINE_DEVICE_DENIED');
    const reference = await serverReferenceRate(client, input.currency);
    const totalReference = await serverEurMinor(client, input.maximumTotalMinor, input.currency, reference);
    const singleReference = await serverEurMinor(client, input.maximumSingleMinor, input.currency, reference);
    if (totalReference < 1 || totalReference > 30000 || singleReference < 1 || singleReference > 5000) {
      throw new Error('OFFLINE_AUTHORIZATION_LIMIT');
    }
    const id = crypto.randomUUID();
    await client.query(`INSERT INTO konektag.core_offline_authorizations
      (id,device_id,owner_user_id,currency,maximum_count,maximum_total_minor,maximum_single_minor,
       total_eur_equivalent_minor,single_eur_equivalent_minor,starts_at,expires_at,server_decision,decision_version,
       reference_currency,reference_rate,reference_rate_id,reference_rate_inverse,reference_converted_at,reference_source,reference_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now()+($10 * interval '1 hour'),'APPROVED',$11,
              'EUR',$12,$13,$14,$15,$16,'VERIFIED')`,
      [id,input.deviceId,input.ownerUserId,input.currency,input.maximumCount,input.maximumTotalMinor,
       input.maximumSingleMinor,totalReference,singleReference,input.durationHours,input.decisionVersion,
       reference.rate,reference.rateId,reference.inverse,reference.convertedAt,
       input.currency === 'EUR' ? 'EUR_PARITY' : 'SERVER_RATE']);
    if (ownsTransaction) await client.query('COMMIT');
    return id;
  } catch (error) { if (ownsTransaction) await client.query('ROLLBACK'); throw error; }
  finally { if (ownsTransaction) client.release(); }
}

/** Records the canonical transaction's evidence. It does not settle payment or synchronize devices. */
export async function attachOfflineEvidence(input: {
  transactionId: string; ownerUserId: string; deviceId: string; authorizationId: string;
  clientTransactionId: string; localCounter: number; envelope: object; proofs: object;
  syncState: Extract<OfflineSyncState, 'CREATED' | 'DELIVERED_TO_MERCHANT' | 'SYNC_PENDING'>;
}, transactionClient?: PoolClient): Promise<string> {
  if (!input.clientTransactionId || !Number.isSafeInteger(input.localCounter) || input.localCounter < 0) throw new Error('INVALID_OFFLINE_ID');
  const client = transactionClient ?? await pool.connect();
  const ownsTransaction = !transactionClient;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const device = await client.query(`SELECT 1 FROM konektag.core_offline_devices
      WHERE id=$1 AND owner_user_id=$2 AND state='ACTIVE' FOR UPDATE`, [input.deviceId, input.ownerUserId]);
    if (!device.rowCount) throw new Error('OFFLINE_DEVICE_DENIED');
    const authorization = await client.query<{
      currency: string;
      reference_rate: string; reference_rate_id: string | null; reference_rate_inverse: boolean;
      reference_converted_at: Date;
    }>(`SELECT a.currency, a.reference_rate::text, a.reference_rate_id, a.reference_rate_inverse,
         a.reference_converted_at
       FROM konektag.core_offline_authorizations a
       JOIN konektag.core_offline_devices d ON d.id = a.device_id AND d.owner_user_id = a.owner_user_id
       WHERE a.id=$1 AND a.device_id=$2 AND a.owner_user_id=$3 AND a.server_decision='APPROVED'
         AND a.starts_at <= now() AND a.expires_at > now() AND d.state='ACTIVE'
         AND a.reference_status='VERIFIED'
       FOR UPDATE OF a`, [input.authorizationId, input.deviceId, input.ownerUserId]);
    const allowance = authorization.rows[0];
    if (!allowance) throw new Error('OFFLINE_AUTHORIZATION_DENIED');
    const transaction = await client.query<{ customer_user_id: string; currency: string; total_minor: string }>(
      `SELECT customer_user_id, currency, total_minor FROM konektag.core_transactions WHERE id=$1 FOR UPDATE`, [input.transactionId]);
    const tx = transaction.rows[0];
    if (!tx || tx.customer_user_id !== input.ownerUserId || tx.currency !== allowance.currency) throw new Error('OFFLINE_TRANSACTION_MISMATCH');
    assertMoney({ amountMinor: Number(tx.total_minor), currency: tx.currency });
    const existing = await client.query<{ transaction_id: string; authorization_id: string; device_id: string; local_counter: string; payload_matches: boolean }>(
      `SELECT o.transaction_id, o.authorization_id, o.device_id, o.local_counter,
         (o.envelope=$3::jsonb AND o.proofs=$4::jsonb) AS payload_matches
       FROM konektag.core_transaction_offline o
       JOIN konektag.core_offline_authorizations a ON a.id=o.authorization_id
       WHERE a.owner_user_id=$1 AND o.client_transaction_id=$2`,
      [input.ownerUserId, input.clientTransactionId, JSON.stringify(input.envelope), JSON.stringify(input.proofs)]);
    if (existing.rows[0]) {
      if (existing.rows[0].transaction_id !== input.transactionId ||
          existing.rows[0].authorization_id !== input.authorizationId ||
          existing.rows[0].device_id !== input.deviceId ||
          BigInt(existing.rows[0].local_counter) !== BigInt(input.localCounter) ||
          !existing.rows[0].payload_matches) throw new Error('OFFLINE_REPLAY_CONFLICT');
      if (ownsTransaction) await client.query('COMMIT');
      return input.transactionId;
    }
    const referenceAmount = await serverEurMinor(client, Number(tx.total_minor), tx.currency,
      { rate: allowance.reference_rate, inverse: allowance.reference_rate_inverse });
    const branch = await client.query(`SELECT 1 FROM konektag.core_transaction_offline
      WHERE device_id=$1 AND local_counter=$2 LIMIT 1`, [input.deviceId, input.localCounter]);
    const conflict = !!branch.rowCount;
    if (conflict) {
      await client.query(`UPDATE konektag.core_transaction_offline
        SET sync_state='REQUIRES_REVIEW', conflict_reason='COUNTER_BRANCH'
        WHERE device_id=$1 AND local_counter=$2 AND sync_state <> 'SETTLED'`, [input.deviceId, input.localCounter]);
    }
    await client.query(`INSERT INTO konektag.core_transaction_offline
       (transaction_id, authorization_id, device_id, client_transaction_id,
        local_counter, envelope, proofs, sync_state, conflict_reason,
        reference_amount_minor,reference_currency,reference_rate,reference_rate_id,reference_rate_inverse,reference_converted_at,reference_source,reference_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'EUR',$11,$12,$13,$15,$14,'VERIFIED')`,
    [input.transactionId, input.authorizationId, input.deviceId,
      input.clientTransactionId, input.localCounter, input.envelope, input.proofs,
      conflict ? 'REQUIRES_REVIEW' : input.syncState, conflict ? 'COUNTER_BRANCH' : null,
      referenceAmount, allowance.reference_rate, allowance.reference_rate_id, allowance.reference_rate_inverse,
      tx.currency === 'EUR' ? 'EUR_PARITY' : 'SERVER_RATE', allowance.reference_converted_at]);
    if (ownsTransaction) await client.query('COMMIT');
    return input.transactionId;
  } catch (error) { if (ownsTransaction) await client.query('ROLLBACK'); throw error; }
  finally { if (ownsTransaction) client.release(); }
}
