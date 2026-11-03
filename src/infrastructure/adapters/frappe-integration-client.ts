const SUPPORTED_EVENTS = new Set([
  'MERCHANT_SALE_CREATED',
  'MERCHANT_SETTLEMENT_PREPARED',
  'MERCHANT_SETTLEMENT_APPROVED',
  'MERCHANT_SETTLEMENT_BANK_PENDING',
  'MERCHANT_SETTLEMENT_PROOF_AWAITING_VERIFICATION',
  'MERCHANT_SETTLEMENT_PROOF_REJECTED',
  'MERCHANT_SETTLEMENT_SETTLED',
  'CLEARING_FROZEN',
  'CLEARING_APPROVED',
  'CLEARING_SETTLED',
]);

export interface FrappeProjectionEvent {
  event_id: string;
  event_type: string;
  event_version: 1;
  operation_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export function isFrappeProjectionEvent(eventType: string): boolean {
  return SUPPORTED_EVENTS.has(eventType);
}

export async function dispatchFrappeProjectionEvent(event: FrappeProjectionEvent): Promise<void> {
  if (!isFrappeProjectionEvent(event.event_type)) {
    throw new Error('FRAPPE_INTEGRATION_EVENT_UNSUPPORTED');
  }

  const baseUrl = process.env.ERPNEXT_URL?.replace(/\/$/, '');
  const secret = process.env.KONEKTAG_INTEGRATION_SECRET;
  if (!baseUrl) throw new Error('FRAPPE_INTEGRATION_URL_MISSING');
  if (!secret) throw new Error('FRAPPE_INTEGRATION_SECRET_MISSING');

  const response = await fetch(`${baseUrl}/api/method/konektag_integration.konektag_integration.api.receive_event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Konektag-Integration-Secret': secret,
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(`FRAPPE_INTEGRATION_HTTP_${response.status}`);
  }
}
