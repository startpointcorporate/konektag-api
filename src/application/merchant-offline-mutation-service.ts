import {NATIVE_CATALOG_RETIRED} from '../domain/native-catalog-retirement.ts';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../infrastructure/database/pool.ts';
import { requireCoreMerchantActor } from './core-transaction-service.ts';
import { getCorrelationId } from '../infrastructure/correlation-id.ts';

export type OfflineMutationType = 'account' | 'profile' | 'commerce' | 'product' | 'tax';
export interface OfflineMutationInput {
  commandId: string;
  merchantProfileId: string;
  objectType: OfflineMutationType;
  objectId: string;
  expectedVersion: number;
  patch: Record<string, unknown>;
}

const profileFields: Record<string, string> = {
  shortDescription: 'short_description', longDescription: 'long_description', address: 'address',
  city: 'city', neighborhood: 'neighborhood', websiteUrl: 'website_url',
};
const accountFields: Record<string, string> = { locale: 'locale', displayName: 'display_name' };
const commerceFields: Record<string, string> = {
  mainActivity: 'main_activity', priceRange: 'price_range', productsServices: 'products_services',
  hasCatalog: 'has_catalog',
};
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

function conflictError(expectedVersion: number, remoteVersion: number, remoteValue: Record<string, unknown>, patch: Record<string, unknown>): Error & { code?: string; details?: unknown } {
  const error = new Error('VERSION_CONFLICT') as Error & { code?: string; details?: unknown };
  error.code = 'VERSION_CONFLICT';
  error.details = { localVersion: expectedVersion, remoteVersion, localValue: patch, remoteValue };
  return error;
}

async function updateVersionedRow(client: PoolClient, input: OfflineMutationInput, actorUserId: string): Promise<Record<string, unknown>> {
  if (input.objectType === 'account') {
    const entries = Object.entries(input.patch).filter(([key]) => accountFields[key]);
    if (!entries.length || entries.length !== Object.keys(input.patch).length) throw new Error('FIELD_NOT_EDITABLE_OFFLINE');
    const { rows: [row] } = await client.query('SELECT * FROM konektag.users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [input.objectId]);
    if (!row) throw new Error('NOT_FOUND');
    if (Number(row.version) !== input.expectedVersion) throw conflictError(input.expectedVersion, Number(row.version), row, input.patch);
    const values: unknown[] = []; const assignments: string[] = [];
    entries.forEach(([key, value], index) => { assignments.push(`${accountFields[key]}=$${index + 1}`); values.push(value); });
    const idParam = values.length + 2; const versionParam = values.length + 3; const actorParam = values.length + 1;
    const { rows: [updated] } = await client.query(`UPDATE konektag.users SET ${assignments.join(',')}, version=version+1, updated_at=now(), updated_by=$${actorParam} WHERE id=$${idParam} AND version=$${versionParam} RETURNING *`, [...values, actorUserId, input.objectId, input.expectedVersion]);
    if (!updated) throw conflictError(input.expectedVersion, input.expectedVersion + 1, row, input.patch);
    return updated;
  }
  if (input.objectType === 'profile' || input.objectType === 'commerce') {
    const table = input.objectType === 'profile' ? 'merchant_profiles' : 'commerce_profiles';
    const fields = input.objectType === 'profile' ? profileFields : commerceFields;
    const { rows: [row] } = await client.query(`SELECT * FROM konektag.${table} WHERE ${input.objectType === 'profile' ? 'id' : 'merchant_profile_id'}=$1 ${input.objectType === 'profile' ? 'AND deleted_at IS NULL' : 'AND deleted_at IS NULL'} FOR UPDATE`, [input.objectType === 'profile' ? input.objectId : input.merchantProfileId]);
    const entries = Object.entries(input.patch).filter(([key]) => fields[key]);
    if (!entries.length || entries.length !== Object.keys(input.patch).length) throw new Error('FIELD_NOT_EDITABLE_OFFLINE');
    if (!row) throw new Error('NOT_FOUND');
    if (Number(row.version) !== input.expectedVersion) throw conflictError(input.expectedVersion, Number(row.version), row, input.patch);
    const values: unknown[] = []; const assignments: string[] = [];
    entries.forEach(([key, value], index) => { assignments.push(`${fields[key]}=$${index + 1}`); values.push(value); });
    const key = input.objectType === 'profile' ? 'id' : 'merchant_profile_id';
    const actorParam = values.length + 1;
    const keyParam = values.length + 2;
    const versionParam = values.length + 3;
    const params = [...values, actorUserId, input.objectType === 'profile' ? input.objectId : input.merchantProfileId, input.expectedVersion];
    const auditColumn = input.objectType === 'profile' ? `, updated_by=$${actorParam}` : '';
    const { rows: [updated] } = await client.query(`UPDATE konektag.${table} SET ${assignments.join(',')}, version=version+1, updated_at=now()${auditColumn} WHERE ${key}=$${keyParam} AND version=$${versionParam} RETURNING *`, params);
    if (!updated) throw conflictError(input.expectedVersion, input.expectedVersion + 1, row, input.patch);
    return updated;
  }
  throw new Error('FIELD_NOT_EDITABLE_OFFLINE');
}

export async function applyMerchantOfflineMutation(actorUserId: string, input: OfflineMutationInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireCoreMerchantActor(client, input.merchantProfileId, actorUserId);
    const requestHash = hash(input);
    const { rows: [existing] } = await client.query('SELECT request_hash, response FROM konektag.merchant_offline_mutation_receipts WHERE command_id=$1 AND actor_user_id=$2 FOR UPDATE', [input.commandId, actorUserId]);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new Error('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return existing.response;
    }
    // Acknowledged legacy commands may replay; unsynchronized product/tax edits are retired.
    if(input.objectType==='product'||input.objectType==='tax')throw new Error(NATIVE_CATALOG_RETIRED);
    const updated = await updateVersionedRow(client, input, actorUserId);
    const response = JSON.parse(JSON.stringify({ commandId: input.commandId, state: 'synced', objectType: input.objectType, objectId: input.objectId, version: Number(updated.version), value: updated }));
    await client.query(`INSERT INTO konektag.merchant_offline_mutation_receipts(command_id,merchant_profile_id,actor_user_id,object_type,object_id,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.commandId, input.merchantProfileId, actorUserId, input.objectType, input.objectId, requestHash, response]);
    await client.query('INSERT INTO konektag.audit_logs(user_id,correlation_id,event_type,payload) VALUES($1,$2,$3,$4)', [actorUserId, getCorrelationId(), 'MERCHANT_OFFLINE_MUTATION_APPLIED', { ...input, version: updated.version }]);
    await client.query('COMMIT');
    return response;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

