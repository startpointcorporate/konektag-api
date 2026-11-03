import pool from '../../infrastructure/database/pool.ts';

export async function changeAccountAccess(input: { userId: string; actorId: string; blocked: boolean; reason: string; idempotencyKey: string; sourceSystem?: 'ERP' | 'KONEKTAG'; externalReference?: string }) {
  const client = await pool.connect();
  let action: any;
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(`SELECT * FROM konektag.account_access_actions WHERE idempotency_key = $1 FOR UPDATE`, [input.idempotencyKey]);
    if (existing[0]) { action = existing[0]; await client.query('COMMIT'); }
    else {
      const { rows } = await client.query(`SELECT id, keycloak_id FROM konektag.users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [input.userId]);
      if (!rows[0]) throw new Error('USER_NOT_FOUND');
      const target = rows[0];
      const status = input.blocked ? 'BLOCKED' : 'ACTIVE';
      await client.query(`UPDATE konektag.users SET access_status = $1, access_block_reason = $2, access_changed_at = now() WHERE id = $3`, [status, input.blocked ? input.reason : null, input.userId]);
      const inserted = await client.query(
        `INSERT INTO konektag.account_access_actions (user_id, actor_id, action, idempotency_key, reason, source_system, external_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [input.userId, input.actorId, input.blocked ? 'BLOCK' : 'UNBLOCK', input.idempotencyKey, input.reason, input.sourceSystem ?? 'KONEKTAG', input.externalReference ?? null],
      );
      await client.query(`INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload) VALUES ($1,$2,'user',$3,$4,$5)`, [input.actorId, input.blocked ? 'ACCOUNT_BLOCK' : 'ACCOUNT_UNBLOCK', input.userId, input.reason, JSON.stringify({ idempotencyKey: input.idempotencyKey })]);
      await client.query(
        `INSERT INTO konektag.outbox_events (correlation_id, causation_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version, payload)
         VALUES (gen_random_uuid(),gen_random_uuid(),'AccountAccessAction',$1,$1,'AccountAccessChanged',1,$2)`,
        [inserted.rows[0].id, JSON.stringify({ actionId: inserted.rows[0].id, userId: input.userId, keycloakId: target.keycloak_id, status, reason: input.reason })],
      );
      action = { ...inserted.rows[0], keycloak_id: target.keycloak_id };
      await client.query('COMMIT');
    }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  return { success: true, actionId: action.id, keycloakStatus: action.keycloak_status ?? 'PENDING' };
}
