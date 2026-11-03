export function operationsJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
export function operationsError(error: unknown) {
  const code = error instanceof Error ? error.message : 'SERVER_ERROR';
  const details = error && typeof error === 'object' && 'details' in error ? (error as { details?: unknown }).details : undefined;
  const status = code === 'NATIVE_CATALOG_RETIRED' ? 410 : code === 'MERCHANT_ACCESS_DENIED' ? 403 : code === 'IDEMPOTENCY_CONFLICT' || code === 'VERSION_CONFLICT' || code === 'PROMOTION_VERSION_CONFLICT' ? 409
    : code === 'NOT_FOUND' ? 404 : code === 'FIELD_NOT_EDITABLE_OFFLINE' || code === 'PROMOTION_CONFLICT' || code === 'PROMOTION_NOT_APPLICABLE' || code.startsWith('INVALID') || code === 'PRICE_MISMATCH' || code === 'AMOUNT_OUT_OF_RANGE' ? 422 : 500;
  if (status === 500) console.error('[merchant-operations]', error);
  return operationsJson({ error: status === 500 ? 'SERVER_ERROR' : code, ...(details ? { details } : {}) }, status);
}

