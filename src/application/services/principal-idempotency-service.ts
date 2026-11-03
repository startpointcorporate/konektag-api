import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { HttpIdempotencyRepository } from '../../infrastructure/repositories/http-idempotency-repository.ts';

type Database = Pick<PoolClient, 'query'>;
export class PrincipalReplayConflict extends Error {
  constructor() { super('PRINCIPAL_REPLAY_CONFLICT'); }
}
export function principalCommandHash(command: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');
}
export function principalAttemptKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new Error('PAYMENT_ATTEMPT_REQUIRED');
  return value;
}
export async function readPrincipalReplay(db: Database, actor: string, route: string, key: string, hash: string): Promise<Response | null> {
  const { rows: [row] } = await db.query(
    `SELECT command_hash,status,response_body,response_status FROM konektag.http_idempotency_requests
     WHERE actor_type='USER' AND actor_id=$1 AND legal_entity_id IS NULL AND route_key=$2 AND idempotency_key=$3`,
    [actor, route, key]);
  if (!row) return null;
  if (row.command_hash !== hash) throw new PrincipalReplayConflict();
  return row.status === 'COMPLETED' ? new Response(row.response_body, { status: row.response_status, headers: {'Content-Type':'application/json'} }) : null;
}
/** Must share the principal transaction: response and money become visible at the same COMMIT. */
export async function beginPrincipalAttempt(client: PoolClient, actor: string, route: string, key: string, hash: string) {
  const result = await new HttpIdempotencyRepository(client).insertOrGetFinancialConflict(
    { actorType: 'USER', actorId: actor, legalEntityId: null, routeKey: route }, key, hash);
  if (result.hashConflict) throw new PrincipalReplayConflict();
  if (result.inserted) return { id: result.inserted.id, replay: null };
  const replay = await readPrincipalReplay(client, actor, route, key, hash);
  if (!replay) throw new Error('PAYMENT_ATTEMPT_IN_PROGRESS');
  return { id: result.existing!.id, replay };
}
export async function completePrincipalAttempt(client: PoolClient, id: string, status: number, body: unknown) {
  await new HttpIdempotencyRepository(client).completeResponse(id, 'COMPLETED', status, {'Content-Type':'application/json'}, JSON.stringify(body));
}
