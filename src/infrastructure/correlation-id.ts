import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export const correlationIdCtx = new AsyncLocalStorage<string>();

export function getCorrelationId(): string {
  return correlationIdCtx.getStore() ?? crypto.randomUUID();
}
