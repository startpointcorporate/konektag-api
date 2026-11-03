import { requireOfflinePointsSettlement } from './offline-points-readiness.ts';
import pool from '../infrastructure/database/pool.ts';
import { createOfflineAuthorization, serverReferenceRate, serverEurMinor } from './core-offline-service.ts';
import { signAuthority } from './core02-identity-service.ts';
import { resolveUserOperationCurrency } from './services/operation-currency-service.ts';
import { EnvelopeSchema } from './shared/offline-pay/protocol.ts';

export async function issuePaymentEnvelope(userId: string, deviceId: string) {
  await requireOfflinePointsSettlement();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const device = await client.query(`SELECT id FROM konektag.core_offline_devices
      WHERE id=$1 AND owner_user_id=$2 AND state='ACTIVE' FOR UPDATE`, [deviceId, userId]);
    if (!device.rowCount) throw new Error('DEVICE_DENIED');
    const { rows: [existing] } = await client.query(`SELECT e.token FROM konektag.core_payment_envelopes e
      JOIN konektag.core_offline_authorizations a ON a.id=e.authorization_id
      WHERE a.device_id=$1 AND a.server_decision='APPROVED' AND a.expires_at>now()
      ORDER BY a.starts_at DESC LIMIT 1`, [deviceId]);
    if (existing) { await client.query('COMMIT'); return { envelope: existing.token }; }
    const context = await resolveUserOperationCurrency(client, userId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`wallet-balance:${userId}:${context.currency}`]);
    const { rows: [wallet] } = await client.query(`SELECT COALESCE(SUM(CASE WHEN entry_side='credit' THEN amount ELSE -amount END),0)::text AS balance
      FROM konektag.ledger_entries WHERE client_id=$1 AND account_code='1000' AND currency=$2`, [userId, context.currency]);
    const balance = Number(wallet.balance);
    if (!Number.isSafeInteger(balance) || balance < 1) throw new Error('INSUFFICIENT_BALANCE');
    const reference = await serverReferenceRate(client, context.currency);
    async function cap(eur: number) {
      let lower = 0, upper = balance;
      while (lower < upper) {
        const candidate = lower + Math.ceil((upper - lower) / 2);
        if (await serverEurMinor(client, candidate, context.currency, reference) <= eur) lower = candidate;
        else upper = candidate - 1;
      }
      return lower;
    }
    const total = await cap(30000), single = await cap(5000);
    const id = await createOfflineAuthorization({ deviceId, ownerUserId: userId, currency: context.currency,
      maximumCount: 10, maximumTotalMinor: total, maximumSingleMinor: single, durationHours: 24, decisionVersion: 1 }, client);
    const { rows: [a] } = await client.query(`SELECT * FROM konektag.core_offline_authorizations WHERE id=$1`, [id]);
    const envelope = EnvelopeSchema.parse({ version: 1, authorizationId: id, deviceId, ownerUserId: userId,
      currency: a.currency, maximumCount: a.maximum_count, maximumTotalMinor: Number(a.total_eur_equivalent_minor),
      maximumSingleMinor: Number(a.single_eur_equivalent_minor), issuedAt: Math.floor(a.starts_at.getTime()/1000),
      expiresAt: Math.floor(a.expires_at.getTime()/1000), decisionVersion: a.decision_version });
    const token = await signAuthority(envelope, 'KTG-OFFENV1');
    await client.query(`INSERT INTO konektag.core_payment_envelopes(authorization_id,token) VALUES ($1,$2)`, [id, token]);
    await client.query('COMMIT');
    return { envelope: token };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
