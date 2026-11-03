import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { PrincipalReplayConflict, principalCommandHash } from './principal-idempotency-service.ts';

const route = 'QR_CONFIRMATION';
const actor = 'QR_PAYMENT';
export type QrReplayContract = { payerId: string; token: unknown; amount: number; quantity: number; currency: unknown };
type Attempt = { id: string; command_hash: string; status: string; response_body: string; response_status: number; actor_id: string };

/** The signed token binds beneficiary and payment type; the canonical payer completes the contract. */
export function qrPrincipalCommandHash(payerId: string, requestHash: string): string {
  return principalCommandHash([payerId, requestHash]);
}

/** Transaction required, including for legacy promotion. The identity must outlive HTTP cache cleanup. */
export async function readQrPrincipalReplay(client: PoolClient, legacyActor: string, key: string, hash: string, legacyHash: string, contract: QrReplayContract): Promise<Response | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`qr-payment-identity:${key}`]);
  const { rows: [current] } = await client.query<Attempt>(
    `SELECT * FROM konektag.http_idempotency_requests
     WHERE actor_type='SERVICE' AND actor_id=$1 AND legal_entity_id IS NULL AND route_key=$2 AND idempotency_key=$3`,
    [actor, route, key]);
  if (current) {
    if (current.command_hash !== hash) throw new PrincipalReplayConflict();
    if (current.status !== 'COMPLETED') throw new Error('PAYMENT_ATTEMPT_IN_PROGRESS');
    return response(current);
  }
  // Older handlers scoped txId by user. Do not reinterpret an existing identity,
  // even if the old cache expiry has elapsed. Reject ambiguous historical collisions.
  const { rows: legacy } = await client.query<Attempt>(
    `SELECT * FROM konektag.http_idempotency_requests
     WHERE actor_type='USER' AND legal_entity_id IS NULL AND route_key=$1 AND idempotency_key=$2`, [route, key]);
  if (!legacy.length) return recoverPurgedLegacy(client, legacyActor, key, hash, contract);
  if (legacy.length !== 1 || legacy[0].actor_id !== legacyActor || legacy[0].command_hash !== legacyHash) {
    throw new PrincipalReplayConflict();
  }
  const old = legacy[0];
  if (old.status !== 'COMPLETED') throw new Error('PAYMENT_ATTEMPT_IN_PROGRESS');
  await client.query(
    `INSERT INTO konektag.http_idempotency_requests
     (actor_type,actor_id,legal_entity_id,route_key,http_method,normalized_path,idempotency_key,command_hash,request_fingerprint,status,expires_at,response_status,response_headers,response_body,completed_at)
     VALUES ('SERVICE',$1,NULL,$2,'POST',$2,$3,$4,$4,'COMPLETED','infinity',$5,'{"Content-Type":"application/json"}'::jsonb,$6,now())`,
    [actor, route, key, hash, old.response_status, old.response_body]);
  return response(old);
}

/** Runs in the same transaction as the financial mutation and stored response. */
export async function beginQrPrincipalAttempt(client: PoolClient, legacyActor: string, key: string, hash: string, legacyHash: string, contract: QrReplayContract) {
  const replay = await readQrPrincipalReplay(client, legacyActor, key, hash, legacyHash, contract);
  if (replay) return { id: '', replay };
  const { rows: [row] } = await client.query<{ id: string }>(
    `INSERT INTO konektag.http_idempotency_requests
     (actor_type,actor_id,legal_entity_id,route_key,http_method,normalized_path,idempotency_key,command_hash,request_fingerprint,status,expires_at)
     VALUES ('SERVICE',$1,NULL,$2,'POST',$2,$3,$4,$4,'PROCESSING','infinity') RETURNING id`,
    [actor, route, key, hash]);
  return { id: row.id, replay: null };
}

function response(row: Attempt): Response {
  return new Response(row.response_body, { status: row.response_status, headers: { 'Content-Type': 'application/json' } });
}

/** CORE and financial facts survive expiry of the old USER-scoped HTTP cache. */
async function recoverPurgedLegacy(client: PoolClient, legacyActor: string, key: string, hash: string, contract: QrReplayContract): Promise<Response | null> {
  const { rows } = await client.query(
    `SELECT id,customer_user_id,request_hash,total_minor,currency,note,state,substring(request_key from 4 for 36) AS request_id
     FROM konektag.core_transactions
     WHERE left(request_key,3)='QR:' AND substring(request_key from 40 for 1)=':'
       AND substring(request_key from 4 for 36) ~ '^[a-fA-F0-9-]{36}$'
       AND substring(request_key from 41)=$1`, [key]);
  if (!rows.length) return null;
  const core = rows[0];
  if (rows.length !== 1 || core.customer_user_id !== contract.payerId || core.state !== 'CLOSED'
    || typeof contract.token !== 'string' || crypto.createHash('sha256').update(contract.token).digest('hex') !== core.request_hash
    || Number(core.total_minor) !== contract.amount
    || (contract.currency && String(contract.currency).toUpperCase() !== core.currency)) throw new PrincipalReplayConflict();
  let payload: { requestId: string; beneficiaryType: string; beneficiaryId: string; variableAmount: boolean; quantityK?: number };
  try { payload = JSON.parse(Buffer.from(contract.token.split('.')[1], 'base64url').toString()); }
  catch { throw new PrincipalReplayConflict(); }
  // The token is the exact byte sequence of the committed proof, not an untrusted replacement.
  if (payload.requestId !== core.request_id || !['USER','MERCHANT'].includes(payload.beneficiaryType)
    || core.note !== `QR Pay ${payload.beneficiaryType}:${payload.beneficiaryId}`) throw new PrincipalReplayConflict();
  const quantity = Number.isNaN(contract.quantity) && payload.beneficiaryType==='MERCHANT' && !payload.variableAmount
    ? Number(payload.quantityK) : contract.quantity;
  if (!Number.isSafeInteger(quantity) || quantity<=0) throw new PrincipalReplayConflict();
  const operationKey = `QR:${principalCommandHash([legacyActor,payload.beneficiaryType,payload.beneficiaryId,quantity,contract.amount,core.currency,key])}`;
  const { rows: transactions } = await client.query(
    `SELECT id,status,transaction_type,false AS points_only FROM konektag.financial_transactions WHERE idempotency_key=$1
     UNION ALL
     SELECT ko.id,ko.status,ko.operation_type,true AS points_only
     FROM konektag.points_merchant_consumptions c JOIN konektag.k_operations ko ON ko.id=c.k_operation_id
     WHERE c.operation_key=$1 AND ko.operation_type='merchant_consumption'`, [operationKey]);
  const tx = transactions[0];
  if (transactions.length !== 1 || !tx || tx.status !== 'completed') throw new PrincipalReplayConflict();
  if (payload.beneficiaryType === 'MERCHANT') {
    const proof = await client.query(`SELECT 1 FROM konektag.points_merchant_consumptions c JOIN konektag.parties p ON p.id=c.party_id
      JOIN konektag.users u ON u.keycloak_id=p.keycloak_id
      WHERE c.operation_key=$1 AND (c.monetary_transaction_id=$2 OR c.k_operation_id=$2) AND c.merchant_profile_id=$3 AND c.quantity=$4
        AND c.transaction_amount_minor=$5 AND c.transaction_currency=$6 AND u.id=$7`,
      [operationKey,tx.id,payload.beneficiaryId,quantity,contract.amount,core.currency,contract.payerId]);
    if (!proof.rowCount) throw new PrincipalReplayConflict();
  } else {
    const { rows: entries } = await client.query(`SELECT e.entry_side,e.amount,e.currency,e.account_code,u.id AS user_id
      FROM konektag.ledger_entries e LEFT JOIN konektag.parties p ON p.id=e.party_id
      LEFT JOIN konektag.users u ON u.keycloak_id=p.keycloak_id WHERE e.transaction_id=$1`, [tx.id]);
    if (tx.points_only || tx.transaction_type !== 'k_send' || entries.length !== 2 || entries.some(e=>e.currency!=='K' || e.account_code!=='1000' || Number(e.amount)!==quantity)
      || !entries.some(e=>e.entry_side==='debit' && e.user_id===contract.payerId)
      || !entries.some(e=>e.entry_side==='credit' && e.user_id===payload.beneficiaryId)) throw new PrincipalReplayConflict();
  }
  const body = JSON.stringify({ success:true,...(tx.points_only ? {kOperationId:tx.id} : {financialTransactionId:tx.id}),currency:core.currency });
  await client.query(`INSERT INTO konektag.http_idempotency_requests
    (actor_type,actor_id,legal_entity_id,route_key,http_method,normalized_path,idempotency_key,command_hash,request_fingerprint,status,expires_at,response_status,response_headers,response_body,completed_at)
    VALUES('SERVICE',$1,NULL,$2,'POST',$2,$3,$4,$4,'COMPLETED','infinity',200,'{"Content-Type":"application/json"}'::jsonb,$5,now())`,
    [actor,route,key,hash,body]);
  return new Response(body,{status:200,headers:{'Content-Type':'application/json'}});
}
