import crypto from 'node:crypto';
import pool from '../../infrastructure/database/pool.ts';
import { HttpIdempotencyRepository } from '../../infrastructure/repositories/http-idempotency-repository.ts';

const TTL_HOURS = 24;

const FINANCIAL_MUTATION_PREFIXES = [
  '/api/qr/',
  '/api/pay/',
  '/api/cards/',
  '/api/earn/',
  '/api/admin/merchant-settlements/',
  '/api/admin/clearing/',
  '/api/admin/recharges/',
  '/api/admin/finance/',
  '/api/admin/interco/',
  '/api/wallet-authorizations/',
  '/api/activation-challenge/',
  '/api/recharge/',
];

export interface IdempotencyDecision {
  action: 'PROCEED' | 'REPLAY' | 'CONFLICT' | 'IN_PROGRESS';
  recordId: string | null;
  cachedResponse?: Response;
  errorResponse?: Response;
}

export function isFinancialMutation(method: string, path: string): boolean {
  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return false;
  // API checkout mutations are scoped and serialized by their opaque checkout
  // token. Card checkout must remain usable before a payer has a session.
  if (/^\/api\/pay\/checkout\/[^/]+(?:\/.*)?$/.test(path)) return false;
  // Personal receive-link issuance/validation creates only an opaque capability;
  // no K or money moves until the later send/confirmation operation.
  const normalized = normalizePath(path);
  if (
    normalized === '/api/qr/personal-link'
    || normalized === '/api/qr/request-confirmation'
    || normalized === '/api/k/send'
    || normalized.startsWith('/api/k/send/')
    || normalized === '/api/pay/payment-links'
    || normalized === '/api/pay/pay-link'
    || /^\/api\/pay\/payment-links\/[^/]+\/resume$/.test(normalized)
  ) return false;
  return FINANCIAL_MUTATION_PREFIXES.some(p => path.startsWith(p));
}

export function normalizePath(path: string): string {
  return path.replace(/\/$/, '').replace(/\/+$/, '') || '/';
}

export function computeCommandHash(method: string, path: string, body: string): string {
  const input = `${method}:${normalizePath(path)}:${body}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export class HttpIdempotencyService {
  constructor(private repo: HttpIdempotencyRepository) {}

  async beforeHandler(
    actorId: string,
    method: string,
    path: string,
    idempotencyKey: string,
    rawBody: string
  ): Promise<IdempotencyDecision> {
    const normalizedPath = normalizePath(path);
    const commandHash = computeCommandHash(method, path, rawBody);

    const { inserted, existing, hashConflict } = await this.repo.insertOrGetConflict(
      actorId, method, normalizedPath, idempotencyKey, commandHash, TTL_HOURS
    );

    if (inserted) {
      return { action: 'PROCEED', recordId: inserted.id };
    }

    if (!existing) {
      return {
        action: 'PROCEED',
        recordId: null,
        errorResponse: new Response(JSON.stringify({
          error: 'IDEMPOTENCY_INTERNAL_ERROR',
          message: 'Failed to record idempotency request',
        }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
      };
    }

    if (hashConflict) {
      return {
        action: 'CONFLICT',
        recordId: null,
        errorResponse: new Response(JSON.stringify({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Same key with different request content',
        }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
      };
    }

    if (existing.status === 'COMPLETED') {
      const headers: Record<string, string> = existing.responseHeaders || {};
      return {
        action: 'REPLAY',
        recordId: existing.id,
        cachedResponse: new Response(existing.responseBody || '{}', {
          status: existing.responseStatus || 200,
          headers: { 'Content-Type': headers['content-type'] || 'application/json', ...headers },
        }),
      };
    }

    if (existing.status === 'PROCESSING') {
      return {
        action: 'IN_PROGRESS',
        recordId: existing.id,
        errorResponse: new Response(JSON.stringify({
          error: 'OPERATION_IN_PROGRESS',
          message: 'A concurrent request is being processed',
        }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
      };
    }

    if (existing.status === 'FAILED') {
      return { action: 'PROCEED', recordId: existing.id };
    }

    return { action: 'PROCEED', recordId: existing.id };
  }

  async afterHandler(
    recordId: string,
    status: number,
    headers: Record<string, string>,
    body: string
  ): Promise<void> {
    const resultStatus: 'COMPLETED' | 'FAILED' = status >= 500 ? 'FAILED' : 'COMPLETED';
    await this.repo.completeResponse(recordId, resultStatus, status, headers, body);
  }
}

export async function createHttpIdempotencyService(): Promise<HttpIdempotencyService> {
  const client = await pool.connect();
  return new HttpIdempotencyService(new HttpIdempotencyRepository(client));
}
