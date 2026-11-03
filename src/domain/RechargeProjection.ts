export type PaymentMethodType = 'card' | 'mobile_money' | 'crypto';

/// Three orthogonal status dimensions for a recharge projection.
/// Each reports from a different source of authority.
export type RechargeStatus = 'pending' | 'confirmed' | 'failed' | 'reversed';
export type RechargeWorkflowState = RechargeStatus;
export type ProviderStatusDetail = 'not_submitted' | 'submitted' | 'accepted' | 'pending_settlement' | 'completed' | 'rejected' | 'unknown';
export type LedgerStatus = 'not_posted' | 'posted' | 'reversed' | 'inconsistent';

export type PaymentProviderCode =
  | 'STRIPE' | 'GOOGLE_PAY' | 'APPLE_PAY'
  | 'MTN' | 'ORANGE' | 'AIRTEL' | 'MOOV' | 'WAVE' | 'M_PESA' | 'VODACOM'
  | 'USDT_ERC20' | 'USDT_TRC20' | 'USDT_BEP20' | 'USDC_ERC20' | 'USDC_TRC20'
  | 'BTC' | 'ETH';

export interface RechargeProjection {
  id: string;
  rechargeName: string;
  keycloakId: string;
  userId: string | null;
  requestedAmount: number;
  requestedCurrency: string;
  creditedAmount: number | null;
  creditedCurrency: string | null;
  paymentMethod: PaymentMethodType;
  paymentProvider: string | null;

  /// Three-part status
  rechargeStatus: RechargeStatus;
  providerStatusDetail: ProviderStatusDetail | null;
  ledgerStatus: LedgerStatus;

  providerReference: string | null;
  providerPayload: Record<string, unknown> | null;
  providerFees: number | null;
  providerMessage: string | null;

  stripePaymentIntent: string | null;
  mobileMoneyOperator: string | null;
  mobileMoneyPhone: string | null;
  cryptoNetwork: string | null;
  cryptoAddress: string | null;
  internalReference: string | null;
  country: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  reversedAt: string | null;
  anomaly: string | null;

  /// Projection metadata
  projectionVersion: number;
  projectionChecksum: string | null;
  checksumVersion: number;
  causationId: string | null;
}

/// Projection checksum spec:
/// Algorithm: SHA-256
/// Version: 1
/// Fields (canonical order, pipe-separated):
///   recharge_name | keycloak_id | requested_amount | requested_currency |
///   payment_method | payment_provider | recharge_status | provider_status_detail |
///   ledger_status | credited_amount | credited_currency
/// Rules:
///   - All null values → empty string
///   - All amounts → integer (smallest unit, no decimals)
///   - All strings trimmed
///   - No trailing pipe
/// Example:
///   "KTG-RECH-001|kc-user-1|5000|XOF|mobile_money|MTN|confirmed|completed|posted|5000|XOF"

export interface RechargeEvent {
  id: string;
  rechargeId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminAction {
  id: string;
  adminId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  reason: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface PaymentProvider {
  code: string;
  name: string;
  type: PaymentMethodType;
  isActive: boolean;
  metadata: Record<string, unknown>;
  displaySteps: string[];
}

export interface RechargeTimelineEntry {
  sourceType: 'domain_event' | 'admin_action' | 'ledger';
  sourceId: string;
  action: string;
  aggregateRef: string;
  correlationId: string | null;
  causationId: string | null;
  occurredAt: string;
  reason: string | null;
  adminId: string | null;
}
