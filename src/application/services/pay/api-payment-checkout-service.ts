import { createHash, randomBytes, randomUUID } from 'node:crypto';
import countries from 'i18n-iso-countries';
import type { PostFinancialTransactionCommand } from '../../../domain/Accounting.ts';
import type { FinancialAccountCode } from '../../../domain/Accounting.ts';
import { accountingService } from '../accounting-service.ts';
import { redisAdapter } from '../../../infrastructure/adapters/redis-adapter.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { apiPaymentWebhookService, type ApiPaymentWebhookEvent, type PaymentWebhookOrder } from './api-payment-webhook-service.ts';
import { pointsBalance } from './points-wallet-service.ts';
import { valuePointsK } from '../points-k-valuation-service.ts';
import { consumptionService } from '../consumption-service.ts';
import {
  walletDebitAuthorizationService,
  type WalletDebitAuthorizationPayer,
} from './wallet-debit-authorization-service.ts';
import { activationChallengeService } from '../activation-challenge-service.ts';
import { frappeMasterDataProjectionService } from '../frappe-master-data-projection-service.ts';
import { verifyPaymentContextSelection } from './payment-context-resolver.ts';
import { confirmPointsAcquisition } from './points-acquisition-service.ts';
import { createPaymentRailAdapter } from '../../../infrastructure/adapters/payment-rail.ts';
import { minorDigits, type AmountUnit } from './money-unit.ts';
import { MerchantProSubscriptionService } from '../merchant-pro-subscription-service.ts';
import { emailService } from '../resend-service.ts';

export type ApiPaymentEnvironment = 'sandbox' | 'live';
export type ApiPaymentState = 'pending' | 'processing' | 'awaiting_mobile_money' | 'paid' | 'failed' | 'expired' | 'cancelled';
export type ApiPaymentMethod = 'sandbox' | 'wallet' | 'card' | 'mobile_money';
export type ApiPaymentFundingState = 'unprepared' | 'prepared' | 'external_started' | 'finalized';
export type ApiPaymentOrderPurpose = 'merchant_payment' | 'wallet_recharge';

const DEFAULT_CHECKOUT_EXPIRATION_MINUTES = 60;

export interface ApiPaymentPayer {
  userId: string;
  keycloakId: string;
  username: string;
  email?: string;
}

export interface ApiPaymentLineItem {
  reference: string | null;
  label: string;
  quantity: number;
  unitAmount: number;
  taxAmount: number;
  subtotalAmount: number;
  totalAmount: number;
  metadata: Record<string, unknown>;
}

interface ApiPaymentRedirectUrls {
  successUrl: string | null;
  cancelUrl: string | null;
  pendingUrl: string | null;
}

interface ApiPaymentOrderRow {
  id: string;
  merchant_profile_id: string | null;
  order_purpose: ApiPaymentOrderPurpose;
  business_purpose: string;
  target_user_id: string | null;
  environment: ApiPaymentEnvironment;
  merchant_transaction_id: string;
  execution_reference: string | null;
  label: string;
  payer_identity: string;
  line_items: ApiPaymentLineItem[];
  redirect_success_url: string | null;
  redirect_cancel_url: string | null;
  redirect_pending_url: string | null;
  order_metadata: Record<string, unknown>;
  currency: string;
  subtotal_amount: number;
  tax_amount: number;
  fee_amount: number;
  cashback_amount: number;
  total_amount: number;
  amount_unit: AmountUnit;
  state: ApiPaymentState;
  payment_method: ApiPaymentMethod | null;
  stripe_payment_intent_id: string | null;
  wallet_available_amount: number;
  wallet_amount: number;
  wallet_contribution_amount: number;
  external_amount: number;
  provider_expected_amount: number | null;
  payer_party_id: string | null;
  funding_state: ApiPaymentFundingState;
  settlement_legal_entity_id: string | null;
  settlement_regulatory_profile_id: string | null;
  settlement_corridor_id: string | null;
  settlement_regulated_actor_id: string | null;
  settlement_rail: string | null;
  settlement_provider: string | null;
  provider_configuration_key: string | null;
  payment_country: string | null;
  beneficiary_type: MerchantBeneficiaryType | null;
  beneficiary_party_id: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  version: number;
  merchant_name?: string;
  merchant_logo_url?: string | null;
}

export interface CreateApiPaymentOrderInput {
  merchantProfileId: string;
  environment: ApiPaymentEnvironment;
  merchantTransactionId: string;
  purpose?: string;
  amountUnit?: AmountUnit;
  executionReference?: string;
  label: string;
  payerIdentity: string;
  items?: Array<{
    reference?: string;
    label: string;
    quantity: number;
    unitAmount: number;
    taxAmount?: number;
    metadata?: Record<string, unknown>;
  }>;
  redirectUrls?: {
    successUrl?: string;
    cancelUrl?: string;
    pendingUrl?: string;
  };
  metadata?: Record<string, unknown>;
  currency: string;
  subtotalAmount?: number;
  taxAmount?: number;
  cashbackAmount?: number;
}

export interface CreateWalletRechargeOrderInput {
  targetUserId: string;
  currency: string;
  amount: number;
  /** Legacy recharges use MAJOR; ERPNext Points K purchases explicitly use MINOR. */
  amountUnit?: AmountUnit;
  paymentCountry: string;
  /** Konektag site resolved server-side for a Points K purchase; checked again at funding. */
  konektagSite?: { slug: string };
  /** Server-owned references used to reconcile an ERPNext-backed recharge. */
  metadata?: Record<string, unknown>;
}

export class ApiPaymentValidationError extends Error {}
export class ApiPaymentNotFoundError extends Error {}
export class ApiPaymentConflictError extends Error {}
export class ApiPaymentNetworkOperationGuideRequiredError extends ApiPaymentConflictError {
  constructor(operation: NetworkAccountingOperation) { super(`NETWORK_OPERATION_GUIDE_REQUIRED:${operation}`); }
}

export interface ApiPaymentStripeOrder {
  id: string;
  merchantTransactionId: string;
  currency: string;
  totalAmount: number;
  externalAmount: number;
  providerExpectedAmount: number;
  stripePaymentIntentId: string | null;
  providerConfigurationKey: string | null;
}
export interface ApiPaymentMobileMoneyOrder { id: string; currency: string; externalAmount: number; paymentCountry: 'CMR' | 'COG' | 'GAB'; providerConfigurationKey: string | null; }

export interface ApiPaymentFunding {
  amountUnit?: AmountUnit;
  subtotalAmount: number;
  taxAmount: number;
  feeAmount: number;
  totalAmount: number;
  walletAvailable: number;
  walletAmount: number;
  externalAmount: number;
  allowedPaymentMethods: ApiPaymentMethod[];
}

export type ApiPaymentExternalFundingContext = {
  percentageBps: number;
  fixedAmount: number;
  currency: string;
};

export type ApiPaymentFundingSelection = string;

export interface ApiPaymentFundingOptions {
  useWalletPoints?: boolean;
  walletPointsAmount?: number;
}

interface ApiPaymentSettlementSelection extends ApiPaymentExternalFundingContext {
  paymentCountry: string;
  legalEntityId: string;
  regulatoryProfileId: string;
  corridorId: string;
  regulatedActorId: string | null;
  rail: string;
  provider: string;
  providerConfigurationKey: string | null;
  /** Konektag site the signed selection was read on (konektag-fr…). */
  konektagSite?: string | null;
}

interface ApiPaymentSettlementContext {
  merchantPartyId: string;
  legalEntityId: string;
  regulatoryProfileId: string;
  corridorId: string | null;
}

type MerchantBeneficiaryType = 'MERCHANT' | 'NETWORK';
type NetworkAccountingOperation = 'acquisition' | 'fee_collection';

interface NetworkAccountingGuide {
  debitAccount: string;
  creditAccount: string;
}

export interface ApiPaymentWalletAuthorization {
  lifecycle: 'issued' | 'approved';
  amount: number;
  currency: string;
  payeeName: string;
  expiresAt: string;
  approvedAt: string | null;
}

interface ApiPaymentWalletReservationRow {
  id: string;
  authorization_id: string;
  payer_party_id: string;
  amount: number | string;
  currency: string;
  lifecycle: 'active' | 'captured' | 'released' | 'expired';
  expires_at: string | Date;
  captured_at: string | Date | null;
}

type DatabaseClient = {
  query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

// Stored amounts follow amount_unit (legacy MAJOR, explicit MINOR for Points K).
// Keep card currencies explicit so an unknown code is never charged at a wrong scale.
const STRIPE_AMOUNT_MULTIPLIERS: Record<string, 1 | 100> = {
  XOF: 1,
  EUR: 100,
  USD: 100,
  LBP: 100,
  AOA: 100,
  CDF: 100,
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function assertAmount(value: number, field: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new ApiPaymentValidationError(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
}

function assertAbsoluteHttpUrl(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ApiPaymentValidationError(`${field} cannot be empty`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiPaymentValidationError(`${field} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ApiPaymentValidationError(`${field} must use http or https`);
  }
  return parsed.toString();
}

function sanitizeMetadata(metadata: unknown, field: string): Record<string, unknown> {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new ApiPaymentValidationError(`${field} must be an object`);
  }
  return metadata as Record<string, unknown>;
}

function normalizeLineItems(items: CreateApiPaymentOrderInput['items']): ApiPaymentLineItem[] {
  if (!items) return [];
  if (!Array.isArray(items)) throw new ApiPaymentValidationError('items must be an array');
  if (items.length > 200) throw new ApiPaymentValidationError('items supports up to 200 lines');
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApiPaymentValidationError(`items[${index}] must be an object`);
    }
    const label = String(item.label || '').trim();
    if (!label) throw new ApiPaymentValidationError(`items[${index}].label is required`);
    if (label.length > 255) throw new ApiPaymentValidationError(`items[${index}].label is too long`);
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new ApiPaymentValidationError(`items[${index}].quantity must be a positive integer`);
    }
    if (!Number.isSafeInteger(item.unitAmount) || item.unitAmount < 0) {
      throw new ApiPaymentValidationError(`items[${index}].unitAmount must be a non-negative integer`);
    }
    const taxAmount = item.taxAmount === undefined ? 0 : Number(item.taxAmount);
    assertAmount(taxAmount, `items[${index}].taxAmount`);
    const subtotalAmount = item.quantity * item.unitAmount;
    if (!Number.isSafeInteger(subtotalAmount)) {
      throw new ApiPaymentValidationError(`items[${index}] subtotal is too large`);
    }
    const totalAmount = subtotalAmount + taxAmount;
    if (!Number.isSafeInteger(totalAmount)) {
      throw new ApiPaymentValidationError(`items[${index}] total is too large`);
    }
    const reference = item.reference === undefined ? null : String(item.reference).trim();
    if (reference !== null && reference.length > 255) {
      throw new ApiPaymentValidationError(`items[${index}].reference is too long`);
    }
    return {
      reference: reference || null,
      label,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      taxAmount,
      subtotalAmount,
      totalAmount,
      metadata: sanitizeMetadata(item.metadata, `items[${index}].metadata`),
    };
  });
}

export function toStripeAmount(currency: string, totalAmount: number, amountUnit: AmountUnit = 'MAJOR'): number {
  assertAmount(totalAmount, 'totalAmount', false);
  if (amountUnit === 'MINOR') {
    try { minorDigits(currency); } catch { throw new ApiPaymentValidationError('Unsupported minor-unit currency'); }
    if (!STRIPE_AMOUNT_MULTIPLIERS[currency]) throw new ApiPaymentValidationError(`Card payments do not support currency ${currency}`);
    return totalAmount;
  }
  const multiplier = STRIPE_AMOUNT_MULTIPLIERS[currency.toUpperCase()];
  if (!multiplier) {
    throw new ApiPaymentValidationError(`Card payments do not support currency ${currency}`);
  }
  const amount = totalAmount * multiplier;
  if (!Number.isSafeInteger(amount)) {
    throw new ApiPaymentValidationError('totalAmount is too large for Stripe');
  }
  return amount;
}

function paymentCountryAliases(country: string): string[] {
  const normalized = country.trim().toUpperCase();
  const aliases = new Set<string>();

  if (/^[A-Z]{2}$/.test(normalized)) {
    aliases.add(normalized);
  }

  if (/^[A-Z]{3}$/.test(normalized)) {
    const alpha2 = countries.alpha3ToAlpha2(normalized);
    if (alpha2) aliases.add(alpha2);
  }

  if (!aliases.size) {
    const alpha2 = countries.getAlpha2Code(normalized, 'en');
    if (alpha2) aliases.add(alpha2.toUpperCase());
  }

  if (!aliases.size) {
    throw new ApiPaymentValidationError(`Unsupported payment country: ${country}`);
  }

  return [...aliases];
}

function toPublicOrder(order: ApiPaymentOrderRow) {
  const createdAt = new Date(order.created_at);
  const expiresAt = Number.isNaN(createdAt.getTime())
    ? null
    : new Date(createdAt.getTime() + checkoutExpirationMinutes() * 60_000).toISOString();
  return {
    id: order.id,
    purpose: order.business_purpose,
    orderType: order.order_purpose,
    environment: order.environment,
    merchantTransactionId: order.merchant_transaction_id,
    executionReference: order.execution_reference,
    label: order.label,
    payerIdentity: order.payer_identity,
    items: order.line_items,
    redirectUrls: {
      successUrl: order.redirect_success_url,
      cancelUrl: order.redirect_cancel_url,
      pendingUrl: order.redirect_pending_url,
    },
    metadata: order.order_metadata,
    currency: order.currency,
    ...(order.amount_unit === 'MINOR' ? { amountUnit: 'MINOR' as const } : {}),
    subtotalAmount: order.subtotal_amount,
    taxAmount: order.tax_amount,
    feeAmount: order.fee_amount,
    cashbackAmount: order.cashback_amount,
    totalAmount: order.total_amount,
    state: order.state,
    paymentMethod: order.payment_method,
    paymentCountry: order.payment_country,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    expiresAt,
    cancelledAt: order.state === 'cancelled' ? order.updated_at : null,
    paidAt: order.paid_at,
    merchant: order.merchant_name ? {
      name: order.merchant_name,
      logoUrl: order.merchant_logo_url ?? null,
    } : order.order_purpose === 'wallet_recharge' ? { name: 'Konektag', logoUrl: null } : undefined,
  };
}

async function publishPaymentStatus(order: Pick<ApiPaymentOrderRow, 'id' | 'state' | 'payment_method' | 'paid_at'>): Promise<void> {
  try {
    await redisAdapter.publishPaymentStatus(order.id, {
      state: order.state,
      paymentMethod: order.payment_method,
      paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : null,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Pub/Sub is a notification path only; committed payment state remains in PostgreSQL.
    console.error('[api-payment-checkout] Unable to publish payment status');
  }
}

function assertTransition(current: ApiPaymentState, next: ApiPaymentState): void {
  const allowed: Record<ApiPaymentState, ApiPaymentState[]> = {
    pending: ['processing', 'awaiting_mobile_money', 'paid', 'failed', 'expired', 'cancelled'],
    processing: ['pending', 'awaiting_mobile_money', 'paid', 'failed', 'expired', 'cancelled'],
    awaiting_mobile_money: ['pending', 'processing', 'paid', 'failed', 'expired', 'cancelled'],
    paid: [],
    failed: [],
    expired: [],
    cancelled: [],
  };
  if (current !== next && !allowed[current].includes(next)) {
    throw new ApiPaymentConflictError(`Cannot transition payment from ${current} to ${next}`);
  }
}

function checkoutExpirationMinutes(): number {
  const raw = Number(process.env.API_PAYMENT_CHECKOUT_EXPIRATION_MINUTES ?? DEFAULT_CHECKOUT_EXPIRATION_MINUTES);
  if (!Number.isFinite(raw)) return DEFAULT_CHECKOUT_EXPIRATION_MINUTES;
  const rounded = Math.trunc(raw);
  if (rounded < 5) return 5;
  if (rounded > 7 * 24 * 60) return 7 * 24 * 60;
  return rounded;
}

function isTerminalState(state: ApiPaymentState): boolean {
  return state === 'paid' || state === 'failed' || state === 'expired' || state === 'cancelled';
}

function isCheckoutExpired(order: Pick<ApiPaymentOrderRow, 'created_at' | 'state'>): boolean {
  if (isTerminalState(order.state)) return false;
  const createdAt = new Date(order.created_at);
  if (Number.isNaN(createdAt.getTime())) return false;
  const maxAgeMs = checkoutExpirationMinutes() * 60_000;
  return Date.now() - createdAt.getTime() >= maxAgeMs;
}

function toFunding(order: ApiPaymentOrderRow): ApiPaymentFunding {
  const allowedPaymentMethods: ApiPaymentMethod[] = order.amount_unit === 'MINOR' ? ['card', 'mobile_money'] : order.environment === 'sandbox'
    ? ['sandbox']
    : order.external_amount === 0 ? ['wallet'] : ['card', 'mobile_money'];
  return {
    ...(order.amount_unit === 'MINOR' ? { amountUnit: 'MINOR' as const } : {}),
    subtotalAmount: Number(order.subtotal_amount),
    taxAmount: Number(order.tax_amount),
    feeAmount: Number(order.fee_amount),
    totalAmount: Number(order.total_amount),
    walletAvailable: Number(order.wallet_available_amount),
    walletAmount: Number(order.wallet_amount),
    externalAmount: Number(order.external_amount),
    allowedPaymentMethods,
  };
}

/** Routed Konektag site of a signed selection; refuses a selection whose site no longer matches its country. */
async function selectionMasterDataSource(selected: { country: string; konektagSite?: string | null }) {
  const { resolveKonektagSite } = await import('../../shared/konektag-site.ts');
  const { routedFrappeClient } = await import('./payment-context-resolver.ts');
  const route = await resolveKonektagSite(selected.country);
  if (selected.konektagSite && selected.konektagSite !== route.slug) throw new Error('SELECTION_SITE_CHANGED');
  return routedFrappeClient(route);
}

function calculatePaymentFee(amount: number, fees: Pick<ApiPaymentExternalFundingContext, 'percentageBps' | 'fixedAmount'>): number {
  if (!Number.isSafeInteger(fees.percentageBps) || fees.percentageBps < 0
    || !Number.isSafeInteger(fees.fixedAmount) || fees.fixedAmount < 0) {
    throw new ApiPaymentValidationError('Payment fee context is invalid');
  }
  const fee = Math.round(amount * fees.percentageBps / 10_000) + fees.fixedAmount;
  if (!Number.isSafeInteger(fee) || fee < 0) throw new ApiPaymentValidationError('Payment fee context is invalid');
  return fee;
}

function toCheckoutWalletAuthorization(authorization: {
  lifecycle: 'issued' | 'approved' | 'consumed' | 'expired' | 'rejected' | 'revoked'; amount: number; currency: string;
  payeeSnapshot: { displayName: string }; expiresAt: string; approvedAt: string | null;
}): ApiPaymentWalletAuthorization {
  if (authorization.lifecycle !== 'issued' && authorization.lifecycle !== 'approved') {
    throw new ApiPaymentConflictError('Wallet authorization is no longer active');
  }
  return {
    lifecycle: authorization.lifecycle,
    amount: authorization.amount,
    currency: authorization.currency,
    payeeName: authorization.payeeSnapshot.displayName,
    expiresAt: authorization.expiresAt,
    approvedAt: authorization.approvedAt,
  };
}

function buildPayerPartyIdClause(payerPartyId: string | null): { partyId: string | undefined } {
  return { partyId: payerPartyId ?? undefined };
}

export function buildApiPaymentAccountingCommand(
  order: Pick<ApiPaymentOrderRow,
    'id' | 'merchant_profile_id' | 'merchant_transaction_id' | 'currency' | 'total_amount' |
    'fee_amount' | 'wallet_amount' | 'wallet_contribution_amount' | 'external_amount' | 'payer_party_id'> & Partial<Pick<ApiPaymentOrderRow, 'amount_unit'>>,
  paymentMethod: Extract<ApiPaymentMethod, 'wallet' | 'card' | 'mobile_money'>,
  settlementContext: ApiPaymentSettlementContext,
): PostFinancialTransactionCommand {
  const walletAmount = Number(order.wallet_amount);
  const walletContributionAmount = Number(order.wallet_contribution_amount);
  const externalAmount = Number(order.external_amount);
  const totalAmount = Number(order.total_amount);
  const feeAmount = Number(order.fee_amount);
  const merchantAmount = totalAmount - feeAmount;

  if (!Number.isSafeInteger(walletAmount) || !Number.isSafeInteger(walletContributionAmount) || !Number.isSafeInteger(externalAmount)
    || walletAmount < 0 || walletContributionAmount < 0 || externalAmount < 0 || walletContributionAmount + externalAmount !== totalAmount) {
    throw new ApiPaymentConflictError('Checkout funding split is invalid');
  }
  if (!Number.isSafeInteger(feeAmount) || feeAmount < 0 || merchantAmount < 0) {
    throw new ApiPaymentConflictError('Checkout fee is invalid');
  }
  if (walletAmount > 0 && !order.payer_party_id) {
    throw new ApiPaymentConflictError('Wallet funding is missing its payer');
  }
  if (!settlementContext.merchantPartyId || !settlementContext.legalEntityId || !settlementContext.regulatoryProfileId) {
    throw new ApiPaymentConflictError('Merchant settlement context is required');
  }
  if (paymentMethod === 'wallet' && externalAmount !== 0) {
    throw new ApiPaymentConflictError('Wallet does not fully cover this checkout');
  }
  if (paymentMethod !== 'wallet' && externalAmount === 0) {
    throw new ApiPaymentConflictError('Wallet fully covers this checkout');
  }

  const entries: PostFinancialTransactionCommand['entries'] = [];
  if (walletAmount > 0) {
    entries.push({
      accountCode: '1000',
      ...buildPayerPartyIdClause(order.payer_party_id),
      side: 'debit',
      amount: walletContributionAmount,
      description: `Wallet funding for API payment ${order.merchant_transaction_id}`,
    });
  }
  if (externalAmount > 0) {
    entries.push({
      accountCode: paymentMethod === 'mobile_money' ? '6000' : '7000',
      side: 'debit',
      amount: externalAmount,
      description: `External funding for API payment ${order.merchant_transaction_id}`,
    });
  }
  if (merchantAmount > 0) {
    entries.push({
      accountCode: '2000',
      partyId: settlementContext.merchantPartyId,
      side: 'credit',
      amount: merchantAmount,
      description: `Merchant settlement due for API payment ${order.merchant_transaction_id}`,
    });
  }
  if (feeAmount > 0) {
    entries.push({
      accountCode: '3000',
      side: 'credit',
      amount: feeAmount,
      description: `Platform fee for API payment ${order.merchant_transaction_id}`,
    });
  }

  return {
    idempotencyKey: `api-payment-order-accounting:${order.id}`,
    transactionType: 'api_payment',
    businessReference: order.id,
    currency: order.currency,
    amountUnit: order.amount_unit ?? 'MAJOR',
    description: `API payment ${order.merchant_transaction_id}`,
    metadata: {
      merchantProfileId: order.merchant_profile_id,
      paymentOrderId: order.id,
      paymentMethod,
      legalEntityId: settlementContext.legalEntityId,
      regulatoryProfileId: settlementContext.regulatoryProfileId,
      corridorId: settlementContext.corridorId,
      operationId: order.id,
      valueDate: new Date().toISOString().slice(0, 10),
      eligibilityDecision: 'ALLOWED',
    },
    entries,
  };
}

export function buildNetworkApiPaymentAccountingCommand(
  order: Pick<ApiPaymentOrderRow,
    'id' | 'merchant_profile_id' | 'merchant_transaction_id' | 'currency' | 'total_amount' |
    'fee_amount' | 'wallet_amount' | 'external_amount' | 'payer_party_id'> & Partial<Pick<ApiPaymentOrderRow, 'amount_unit'>>,
  paymentMethod: Extract<ApiPaymentMethod, 'wallet' | 'card' | 'mobile_money'>,
  context: ApiPaymentSettlementContext,
  operation: NetworkAccountingOperation,
  guide: NetworkAccountingGuide,
): PostFinancialTransactionCommand {
  const amount = operation === 'acquisition'
    ? Number(order.total_amount)
    : Number(order.fee_amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ApiPaymentConflictError(`NETWORK_OPERATION_AMOUNT_INVALID:${operation}`);
  }

  // The ERP destination resolves debit/credit from the approved guide. The
  // platform ledger only records the funding side and never creates merchant debt.
  const entries: PostFinancialTransactionCommand['entries'] = operation === 'acquisition'
    ? [
        ...(Number(order.wallet_amount) > 0 ? [{
          accountCode: '1000' as const,
          ...buildPayerPartyIdClause(order.payer_party_id),
          side: 'debit' as const,
          amount: Number(order.wallet_amount),
          description: `Network wallet funding for API payment ${order.merchant_transaction_id}`,
        }] : []),
        ...(Number(order.external_amount) > 0 ? [{
          accountCode: (paymentMethod === 'mobile_money' ? '6000' : '7000') as FinancialAccountCode,
          side: 'debit' as const,
          amount: Number(order.external_amount),
          description: `Network external funding for API payment ${order.merchant_transaction_id}`,
        }] : []),
        {
          accountCode: '8000',
          side: 'credit',
          amount,
          description: `Network ${operation} for API payment ${order.merchant_transaction_id}`,
        },
      ]
    : [
        {
          accountCode: '8000',
          side: 'debit',
          amount,
          description: `Network fee source for API payment ${order.merchant_transaction_id}`,
        },
        {
          accountCode: '8000',
          side: 'credit',
          amount,
          description: `Network fee collection for API payment ${order.merchant_transaction_id}`,
        },
      ];

  return {
    idempotencyKey: `api-payment-network-${operation}:${order.id}`,
    transactionType: operation,
    businessReference: order.id,
    currency: order.currency,
    amountUnit: order.amount_unit ?? 'MAJOR',
    description: `Network ${operation} for API payment ${order.merchant_transaction_id}`,
    entries,
    metadata: {
      merchantProfileId: order.merchant_profile_id,
      beneficiaryType: 'NETWORK',
      paymentMethod,
      legalEntityId: context.legalEntityId,
      regulatoryProfileId: context.regulatoryProfileId,
      corridorId: context.corridorId,
      operationId: `${order.id}:${operation}`,
      valueDate: new Date().toISOString().slice(0, 10),
      eligibilityDecision: 'ALLOWED',
      accountingGuide: guide,
    },
  };
}

export const apiPaymentCheckoutService = {
  calculateAmounts(subtotalAmount: number, taxAmount = 0, cashbackAmount = 0) {
    assertAmount(subtotalAmount, 'subtotalAmount', false);
    assertAmount(taxAmount, 'taxAmount');
    assertAmount(cashbackAmount, 'cashbackAmount');

    return {
      subtotalAmount,
      taxAmount,
      feeAmount: 0,
      cashbackAmount,
      totalAmount: subtotalAmount + taxAmount,
    };
  },

  async createOrder(input: CreateApiPaymentOrderInput) {
    if (!input.merchantTransactionId.trim() || !input.label.trim() || !input.payerIdentity.trim()) {
      throw new ApiPaymentValidationError('merchantTransactionId, label, and payerIdentity are required');
    }
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new ApiPaymentValidationError('currency must be a three-letter uppercase code');
    }

    const purpose = (input.purpose || 'merchant_payment').trim().toLowerCase();
    if (!/^[a-z0-9_:-]{3,64}$/.test(purpose)) {
      throw new ApiPaymentValidationError('purpose must match [a-z0-9_:-]{3,64}');
    }
    const amountUnit = input.amountUnit ?? 'MAJOR';
    if (purpose === 'pro_subscription_renewal' && amountUnit !== 'MINOR') {
      throw new ApiPaymentValidationError('Pro renewal requires minor units');
    }
    if (amountUnit === 'MINOR' && (purpose !== 'pro_subscription_renewal'
      || input.environment !== 'live' || (input.taxAmount ?? 0) !== 0 || (input.cashbackAmount ?? 0) !== 0 || input.items?.length)) {
      throw new ApiPaymentValidationError('Minor unit checkout requires a live Pro renewal without tax or cashback');
    }
    if (amountUnit === 'MINOR') { try { minorDigits(input.currency); } catch { throw new ApiPaymentValidationError('Unsupported minor-unit currency'); } }
    if (amountUnit !== 'MAJOR' && amountUnit !== 'MINOR') throw new ApiPaymentValidationError('Invalid amount unit');
    const executionReference = input.executionReference === undefined ? null : input.executionReference.trim();
    if (executionReference !== null && executionReference.length > 255) {
      throw new ApiPaymentValidationError('executionReference is too long');
    }
    const lineItems = normalizeLineItems(input.items);
    const subtotalFromItems = lineItems.reduce((sum, item) => sum + item.subtotalAmount, 0);
    const taxFromItems = lineItems.reduce((sum, item) => sum + item.taxAmount, 0);
    const subtotalAmount = input.subtotalAmount ?? (lineItems.length ? subtotalFromItems : undefined);
    const taxAmount = input.taxAmount ?? (lineItems.length ? taxFromItems : 0);
    if (subtotalAmount === undefined) {
      throw new ApiPaymentValidationError('subtotalAmount is required when items are not provided');
    }
    if (lineItems.length && input.subtotalAmount !== undefined && input.subtotalAmount !== subtotalFromItems) {
      throw new ApiPaymentValidationError('items subtotal does not match subtotalAmount');
    }
    if (lineItems.length && input.taxAmount !== undefined && input.taxAmount !== taxFromItems) {
      throw new ApiPaymentValidationError('items tax does not match taxAmount');
    }
    const redirectUrls: ApiPaymentRedirectUrls = {
      successUrl: input.redirectUrls?.successUrl ? assertAbsoluteHttpUrl(input.redirectUrls.successUrl, 'redirectUrls.successUrl') : null,
      cancelUrl: input.redirectUrls?.cancelUrl ? assertAbsoluteHttpUrl(input.redirectUrls.cancelUrl, 'redirectUrls.cancelUrl') : null,
      pendingUrl: input.redirectUrls?.pendingUrl ? assertAbsoluteHttpUrl(input.redirectUrls.pendingUrl, 'redirectUrls.pendingUrl') : null,
    };
    const metadata = sanitizeMetadata(input.metadata, 'metadata');

    const amounts = this.calculateAmounts(subtotalAmount, taxAmount, input.cashbackAmount ?? 0);
    const checkoutToken = randomBytes(32).toString('base64url');
    const checkoutTokenHash = hashToken(checkoutToken);
    const { rows } = await pool.query<ApiPaymentOrderRow>(
      `INSERT INTO konektag.api_payment_orders (
         merchant_profile_id, order_purpose, business_purpose, environment, merchant_transaction_id,
          execution_reference, label, payer_identity, line_items,
          redirect_success_url, redirect_cancel_url, redirect_pending_url, order_metadata, currency,
          subtotal_amount, tax_amount, fee_amount, cashback_amount, total_amount,
         wallet_available_amount, wallet_amount, external_amount, checkout_token_hash, amount_unit
        ) VALUES ($1, 'merchant_payment', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13,
          $14, $15, $16, $17, $18, 0, 0, $18, $19, $20)
       ON CONFLICT (merchant_profile_id, merchant_transaction_id) DO NOTHING
       RETURNING *`,
      [
        input.merchantProfileId, purpose, input.environment, input.merchantTransactionId,
        executionReference, input.label, input.payerIdentity, JSON.stringify(lineItems),
        redirectUrls.successUrl, redirectUrls.cancelUrl, redirectUrls.pendingUrl, JSON.stringify(metadata),
        input.currency, amounts.subtotalAmount, amounts.taxAmount,
        amounts.feeAmount, amounts.cashbackAmount, amounts.totalAmount, checkoutTokenHash, amountUnit,
      ],
    );

    if (rows[0]) return { order: toPublicOrder(rows[0]), checkoutToken, created: true };

    const { rows: existing } = await pool.query<ApiPaymentOrderRow>(
      `SELECT * FROM konektag.api_payment_orders
       WHERE merchant_profile_id = $1 AND merchant_transaction_id = $2`,
      [input.merchantProfileId, input.merchantTransactionId],
    );
    if (!existing[0]) throw new Error('Unable to create payment order');

    // The token is intentionally irrecoverable after first issuance.
    return { order: toPublicOrder(existing[0]), checkoutToken: null, created: false };
  },

  async createWalletRechargeOrder(input: CreateWalletRechargeOrderInput) {
    if (!input.targetUserId) throw new ApiPaymentValidationError('targetUserId is required');
    if (!/^[A-Z]{3}$/.test(input.currency)) {
      throw new ApiPaymentValidationError('currency must be a three-letter uppercase code');
    }
    assertAmount(input.amount, 'amount', false);
    const amountUnit = input.amountUnit ?? 'MAJOR';
    if (amountUnit !== 'MAJOR' && amountUnit !== 'MINOR') throw new ApiPaymentValidationError('Invalid amount unit');
    if (amountUnit === 'MINOR') {
      try { minorDigits(input.currency); } catch { throw new ApiPaymentValidationError('Unsupported minor-unit currency'); }
    }
    if (input.metadata?.erpnextPointsK && amountUnit !== 'MINOR') {
      throw new ApiPaymentValidationError('ERPNext Points K requires explicit MINOR amounts');
    }
    const countryAliases = paymentCountryAliases(input.paymentCountry);
    const paymentCountry = countryAliases[0];
    if (!paymentCountry) throw new ApiPaymentValidationError('paymentCountry is required');

    const checkoutToken = randomBytes(32).toString('base64url');
    const metadata = { ...(input.konektagSite ? { konektagSite: input.konektagSite } : {}), ...(input.metadata ?? {}) };
    const paymentRequest = (metadata as any)?.erpnextPointsK?.paymentRequest;
    const { rows } = await pool.query<ApiPaymentOrderRow>(
      `INSERT INTO konektag.api_payment_orders (
         merchant_profile_id, order_purpose, business_purpose, target_user_id, environment, merchant_transaction_id,
         execution_reference, label, payer_identity, line_items, redirect_success_url, redirect_cancel_url,
         redirect_pending_url, order_metadata, currency, subtotal_amount, tax_amount, fee_amount, cashback_amount,
         total_amount, wallet_available_amount, wallet_amount, external_amount, checkout_token_hash,
         beneficiary_type, beneficiary_party_id, payment_country, amount_unit
       ) VALUES (
         NULL, 'wallet_recharge', 'wallet_recharge', $1, 'live', $2, NULL, 'Wallet recharge', $3,
         '[]'::jsonb, NULL, NULL, NULL, $8::jsonb, $4, $5, 0, 0, 0,
         $5, 0, 0, $5, $6, 'NETWORK', NULL, $7, $9
       ) ON CONFLICT DO NOTHING RETURNING *`,
      [input.targetUserId, `WALLET-RECHARGE-${randomUUID()}`, `user:${input.targetUserId}`,
        input.currency, input.amount, hashToken(checkoutToken), paymentCountry,
        JSON.stringify(metadata), amountUnit],
    );
    if (rows[0]) return { order: toPublicOrder(rows[0]), checkoutToken, created: true };
    if (typeof paymentRequest === 'string' && paymentRequest) {
      const { rows: existing } = await pool.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders
         WHERE target_user_id=$1 AND order_purpose='wallet_recharge'
           AND order_metadata #>> '{erpnextPointsK,paymentRequest}'=$2`,
        [input.targetUserId, paymentRequest],
      );
      if (existing[0]) return { order: toPublicOrder(existing[0]), checkoutToken: null, created: false };
    }
    throw new Error('Unable to create wallet recharge order');
  },

  async getPublicOrder(token: string) {
    if (!token) throw new ApiPaymentNotFoundError('Checkout not found');
    const client = await pool.connect();
    let expiredOrder: ApiPaymentOrderRow | null = null;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT o.*, mp.business_name AS merchant_name, mp.logo_url AS merchant_logo_url
         FROM konektag.api_payment_orders o
         LEFT JOIN konektag.merchant_profiles mp ON mp.id = o.merchant_profile_id AND mp.deleted_at IS NULL
         WHERE o.checkout_token_hash = $1
         LIMIT 1
         FOR UPDATE OF o`,
        [hashToken(token)],
      );
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');
      let publicOrder = order;
      if (isCheckoutExpired(order)) {
        publicOrder = await this.updateState(client, order, 'expired');
        expiredOrder = publicOrder;
      }
      await client.query('COMMIT');
      if (expiredOrder) await publishPaymentStatus(expiredOrder);
      return toPublicOrder(publicOrder);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async getOrder(id: string, principal: { merchantProfileId?: string; userId?: string }) {
    const { rows } = await pool.query<ApiPaymentOrderRow>(
      `SELECT o.*, mp.business_name AS merchant_name, mp.logo_url AS merchant_logo_url
       FROM konektag.api_payment_orders o
       LEFT JOIN konektag.merchant_profiles mp ON mp.id = o.merchant_profile_id AND mp.deleted_at IS NULL
       WHERE o.id = $1 AND (
         ($2::uuid IS NOT NULL AND o.merchant_profile_id = $2::uuid)
          OR ($3::uuid IS NOT NULL AND EXISTS (
            SELECT 1 FROM konektag.merchant_memberships mm
            WHERE mm.merchant_profile_id = o.merchant_profile_id AND mm.user_id = $3::uuid
              AND mm.status = 'active' AND mm.role IN ('owner', 'manager')
          ))
          OR ($3::uuid IS NOT NULL AND o.order_purpose = 'wallet_recharge' AND o.target_user_id = $3::uuid)
       )
       LIMIT 1`,
      [id, principal.merchantProfileId ?? null, principal.userId ?? null],
    );
    if (!rows[0]) throw new ApiPaymentNotFoundError('Payment order not found');
    return toPublicOrder(rows[0]);
  },

  async prepareFunding(token: string, payer?: ApiPaymentPayer, externalContext?: ApiPaymentExternalFundingContext): Promise<ApiPaymentFunding> {
    return toFunding(await this.prepareFundingOrder(token, payer, externalContext));
  },

  async prepareSelectedFunding(
    token: string,
    payer: ApiPaymentPayer | undefined,
    selection: ApiPaymentFundingSelection,
    options: ApiPaymentFundingOptions = {},
  ): Promise<ApiPaymentFunding> {
    const selected = verifyPaymentContextSelection(selection);
    const countryAliases = paymentCountryAliases(selected.country);
    const strictParams = [selected.legalEntityCode, selected.regulatoryProfileCode, selected.rail, selected.corridor,
      selected.regulatedActorCode, selected.provider, selected.currency, countryAliases];
    const strictSql = `SELECT le.id AS legal_entity_id, rp.id AS regulatory_profile_id, rp.corridor_id, rp.regulated_actor_id, rp.rail
        FROM konektag.legal_entities le
        JOIN konektag.regulatory_profiles rp ON rp.legal_entity_id = le.id AND rp.profile_code = $2
          AND rp.rail = $3 AND rp.authorized_operation = 'link_payment' AND rp.status = 'APPROVED'
          AND (rp.country_of_origin IS NULL OR rp.country_of_origin = ANY($8::text[]))
          AND (rp.country_of_destination IS NULL OR rp.country_of_destination = ANY($8::text[]))
          AND (rp.corridor_id = $4 OR REPLACE(UPPER(rp.corridor_id), 'KTG-', '') = REPLACE(UPPER($4), 'KTG-', ''))
          AND rp.deleted_at IS NULL
          AND rp.valid_from <= CURRENT_DATE AND (rp.valid_until IS NULL OR rp.valid_until >= CURRENT_DATE)
        LEFT JOIN konektag.regulated_actors ra ON ra.id = rp.regulated_actor_id AND ra.deleted_at IS NULL
        WHERE (le.code = $1 OR REPLACE(UPPER(le.code), 'KTG-', '') = REPLACE(UPPER($1), 'KTG-', ''))
          AND (le.country_code IS NULL OR le.country_code = ANY($8::text[])) AND le.base_currency = $7
          AND le.status = 'APPROVED' AND le.deleted_at IS NULL
          AND (($5::text IS NULL AND $3 = 'internal' AND $6 = 'internal')
            OR (ra.actor_code = $5 AND ra.status = 'APPROVED'))
        LIMIT 2`;

    const { rows: projectedStrict } = await pool.query<{
      legal_entity_id: string; regulatory_profile_id: string; corridor_id: string; regulated_actor_id: string | null; rail: string;
    }>(strictSql, strictParams);

    let projected = projectedStrict;
    if (projected.length !== 1) {
      try {
        // Project from the Konektag site the selection was read on (FR -> konektag-fr).
        const source = await selectionMasterDataSource(selected);
        await frappeMasterDataProjectionService.projectLegalEntity(selected.legalEntityCode, source);
        if (selected.regulatedActorCode) {
          await frappeMasterDataProjectionService.projectRegulatedActor(selected.regulatedActorCode, source);
        }
        await frappeMasterDataProjectionService.projectRegulatoryProfile(selected.regulatoryProfileCode, source);
        const { rows: projectedAfterSync } = await pool.query<{
          legal_entity_id: string; regulatory_profile_id: string; corridor_id: string; regulated_actor_id: string | null; rail: string;
        }>(strictSql, strictParams);
        projected = projectedAfterSync;
      } catch {
        // Keep the original conflict behaviour; fallback query below remains the final compatibility guard.
      }
    }

    if (projected.length !== 1) {
      const { rows: projectedFallback } = await pool.query<{
        legal_entity_id: string; regulatory_profile_id: string; corridor_id: string; regulated_actor_id: string | null; rail: string;
      }>(
        `SELECT le.id AS legal_entity_id, rp.id AS regulatory_profile_id, rp.corridor_id, rp.regulated_actor_id, rp.rail
          FROM konektag.legal_entities le
          JOIN konektag.regulatory_profiles rp ON rp.legal_entity_id = le.id AND rp.profile_code = $2
            AND rp.rail = $3 AND rp.authorized_operation = 'link_payment' AND rp.status = 'APPROVED'
            AND (rp.corridor_id = $4 OR REPLACE(UPPER(rp.corridor_id), 'KTG-', '') = REPLACE(UPPER($4), 'KTG-', ''))
            AND rp.deleted_at IS NULL
            AND rp.valid_from <= CURRENT_DATE AND (rp.valid_until IS NULL OR rp.valid_until >= CURRENT_DATE)
          LEFT JOIN konektag.regulated_actors ra ON ra.id = rp.regulated_actor_id AND ra.deleted_at IS NULL
          WHERE (le.code = $1 OR REPLACE(UPPER(le.code), 'KTG-', '') = REPLACE(UPPER($1), 'KTG-', ''))
            AND le.base_currency = $7 AND le.status = 'APPROVED' AND le.deleted_at IS NULL
            AND (($5::text IS NULL AND $3 = 'internal' AND $6 = 'internal')
              OR (ra.status = 'APPROVED'))
          LIMIT 2`,
         [selected.legalEntityCode, selected.regulatoryProfileCode, selected.rail, selected.corridor,
           selected.regulatedActorCode, selected.provider, selected.currency],
      );
      projected = projectedFallback;
    }

    if (projected.length !== 1) throw new ApiPaymentConflictError('Selected Payment Context is not available for settlement');
    const settlement = projected[0];
    if (selected.regulatedActorCode && !settlement.regulated_actor_id) {
      throw new ApiPaymentConflictError('Selected Payment Context regulated actor is not available for settlement');
    }
    return this.prepareFundingOrder(token, payer, {
       ...selected.fees,
       currency: selected.currency,
       paymentCountry: selected.country,
       legalEntityId: settlement.legal_entity_id,
       regulatoryProfileId: settlement.regulatory_profile_id,
       corridorId: settlement.corridor_id,
       regulatedActorId: settlement.regulated_actor_id,
       rail: settlement.rail,
        provider: selected.provider,
        providerConfigurationKey: selected.providerConfigurationKey,
        konektagSite: selected.konektagSite ?? null,
    } satisfies ApiPaymentSettlementSelection, options).then(toFunding);
  },

  async preparePointsFunding(
    token: string,
    payer: ApiPaymentPayer | undefined,
    options: ApiPaymentFundingOptions = {},
  ): Promise<ApiPaymentFunding> {
    if (!payer) throw new ApiPaymentConflictError('Points K payment requires an authenticated payer');
    if (options.useWalletPoints === false) throw new ApiPaymentConflictError('Points K must be enabled');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        'SELECT * FROM konektag.api_payment_orders WHERE checkout_token_hash=$1 FOR UPDATE', [hashToken(token)]);
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');
      if (isCheckoutExpired(order)) throw new ApiPaymentConflictError('Checkout expired');
      if (order.environment !== 'live' || order.amount_unit === 'MINOR' || order.order_purpose === 'wallet_recharge')
        throw new ApiPaymentConflictError('Points K funding is not available for this checkout');
      if (order.state !== 'pending' || order.funding_state === 'external_started' || order.funding_state === 'finalized')
        throw new ApiPaymentConflictError('Checkout funding can no longer be changed');
      const payerPartyId = await this.resolvePayerParty(client, payer);
      const points = await pointsBalance(payerPartyId, client);
      const walletAvailable = Math.max(0, Math.floor(points.available));
      const basketAmount = Number(order.subtotal_amount) + Number(order.tax_amount);
      if (!Number.isSafeInteger(basketAmount) || basketAmount <= 0)
        throw new ApiPaymentValidationError('Checkout amount is invalid for Points K');
      const valuation = await valuePointsK({
        sourceCurrency: order.currency,
        sourceAmountMinor: basketAmount,
        context: 'checkout-points-k',
      }, client);
      const requested = options.walletPointsAmount ?? valuation.quantityK;
      if (!Number.isSafeInteger(requested) || requested <= 0 || requested > walletAvailable || requested !== valuation.quantityK)
        throw new ApiPaymentValidationError('Points K balance must cover the complete checkout');
      const update = await client.query<ApiPaymentOrderRow>(
        `UPDATE konektag.api_payment_orders SET wallet_available_amount=$1,wallet_amount=$2,wallet_contribution_amount=$6,external_amount=0,
         fee_amount=0,total_amount=$6,payer_party_id=$3,funding_state='prepared',
         settlement_legal_entity_id=NULL,settlement_regulatory_profile_id=NULL,settlement_corridor_id=NULL,
         settlement_regulated_actor_id=NULL,settlement_rail=NULL,settlement_provider=NULL,provider_configuration_key=NULL,
         payment_country=NULL,beneficiary_type=NULL,beneficiary_party_id=NULL,provider_expected_amount=NULL,
         updated_at=now(),version=version+1 WHERE id=$4 AND version=$5 RETURNING *`,
        [walletAvailable, requested, payerPartyId, order.id, order.version, basketAmount]);
      if (!update.rows[0]) throw new ApiPaymentConflictError('Payment funding changed concurrently');
      await client.query('COMMIT');
      return toFunding(update.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>undefined);
      throw error;
    } finally { client.release(); }
  },

  async prepareFundingOrder(
    token: string,
    payer?: ApiPaymentPayer,
    externalContext?: ApiPaymentExternalFundingContext | ApiPaymentSettlementSelection,
    options: ApiPaymentFundingOptions = {},
  ): Promise<ApiPaymentOrderRow> {
    if (!token) throw new ApiPaymentNotFoundError('Checkout not found');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders WHERE checkout_token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');

      // Previously issued ERPNext orders may have stored cents as MAJOR.
      // Refuse to collect them; never guess or rewrite historical payment amounts.
      if (order.order_metadata?.erpnextPointsK && order.amount_unit !== 'MINOR') {
        throw new ApiPaymentConflictError('ERPNext Points K amount unit must be corrected before funding');
      }

      if (isCheckoutExpired(order)) {
        const expired = await this.updateState(client, order, 'expired');
        await client.query('COMMIT');
        await publishPaymentStatus(expired);
        return expired;
      }

      if (order.environment !== 'live') {
        await client.query('COMMIT');
        return order;
      }

      const isWalletRecharge = order.order_purpose === 'wallet_recharge';
      const isErpnextPointsK = isWalletRecharge && Boolean(order.order_metadata?.erpnextPointsK);
      // Merchant requests validate their merchant configuration. Network wallet
      // recharges are intentionally merchantless and freeze NETWORK directly.
      if (!isWalletRecharge && order.business_purpose !== 'pro_subscription_renewal') {
        await this.resolveBeneficiaryType(client, order.merchant_profile_id!);
      }

      if (order.funding_state === 'external_started' || order.funding_state === 'finalized' || order.state !== 'pending') {
        await this.assertPayerMatchesFunding(client, order, payer);
        await client.query('COMMIT');
        return order;
      }

        const settlementContext = externalContext as ApiPaymentSettlementSelection | undefined;
        if (order.business_purpose === 'pro_subscription_renewal' && settlementContext
          && order.order_metadata?.paymentCountry !== settlementContext.paymentCountry) {
          throw new ApiPaymentConflictError('Pro renewal quote belongs to another payment country');
        }
        // A checkout routed to a Konektag site (Points K purchase) only accepts a context
        // read on that site, so the fees shown to the payer are those of the checkout.
        const routedSite = (order.order_metadata?.konektagSite as { slug?: string } | undefined)?.slug;
        if (routedSite && settlementContext?.regulatoryProfileId && settlementContext.konektagSite !== routedSite) {
          throw new ApiPaymentConflictError('Selected Payment Context comes from another Konektag site');
        }
      if (order.funding_state === 'prepared' && !settlementContext?.regulatoryProfileId) {
        await this.assertPayerMatchesFunding(client, order, payer);
        await client.query('COMMIT');
        return order;
      }
      if (order.funding_state === 'prepared' && settlementContext?.regulatoryProfileId) {
        const { rows: reservations } = await client.query<{ id: string }>(
          `SELECT id FROM konektag.api_payment_wallet_reservations
           WHERE payment_order_id = $1 AND lifecycle = 'active' AND expires_at > now() LIMIT 1`, [order.id],
        );
        if (reservations[0] || order.stripe_payment_intent_id) {
          throw new ApiPaymentConflictError('Checkout payment selection can no longer be changed');
        }
      }

        if (isWalletRecharge && (!settlementContext?.regulatoryProfileId || settlementContext.rail === 'internal')) {
          throw new ApiPaymentConflictError('Wallet recharge requires an externally funded selected Payment Context');
        }
        const walletContributionEnabled = !isWalletRecharge && order.amount_unit !== 'MINOR' && options.useWalletPoints !== false;
        const customWalletAmount = options.walletPointsAmount;
        if (customWalletAmount !== undefined
          && (!Number.isSafeInteger(customWalletAmount) || customWalletAmount < 0)) {
          throw new ApiPaymentValidationError('walletPointsAmount must be a non-negative integer');
        }
        if (!walletContributionEnabled && customWalletAmount !== undefined && customWalletAmount > 0) {
          throw new ApiPaymentValidationError('walletPointsAmount is not allowed when wallet points are disabled');
        }
        let payerPartyId: string | null = null;
        let walletAvailable = 0;
        if (payer && walletContributionEnabled) {
          payerPartyId = await this.resolvePayerParty(client, payer);
          const points = await pointsBalance(payerPartyId, client);
          walletAvailable = Math.max(0, Math.floor(points.available));
      }
        let taxAmount = Number(order.tax_amount);
        // This recharge already contains the native ERPNext TTC. Legacy wallet
        // tax rules must not tax that payable amount a second time.
        if (isWalletRecharge && !isErpnextPointsK && settlementContext?.paymentCountry) {
          const aliases = paymentCountryAliases(settlementContext.paymentCountry);
          const { rows: taxRules } = await client.query<{ rate_basis_points: number }>(
            `SELECT rate_basis_points
             FROM konektag.wallet_recharge_tax_rules
             WHERE country_code = ANY($1::text[]) AND enabled = true
               AND valid_from <= CURRENT_DATE
               AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
             ORDER BY valid_from DESC LIMIT 2`,
            [aliases],
          );
          if (taxRules.length > 1) throw new ApiPaymentConflictError('Wallet recharge tax rule is ambiguous');
          const rateBps = Number(taxRules[0]?.rate_basis_points ?? 0);
          taxAmount = Math.round(Number(order.subtotal_amount) * rateBps / 10_000);
          if (!Number.isSafeInteger(taxAmount) || taxAmount < 0) throw new ApiPaymentValidationError('Wallet recharge tax amount is invalid');
        }
        const basketAmount = Number(order.subtotal_amount) + taxAmount;
        if (!externalContext) {
          throw new ApiPaymentConflictError('Payment funding requires a payment fee context');
        }
        if (externalContext && externalContext.currency !== order.currency) {
          throw new ApiPaymentConflictError('Payment fee context currency does not match checkout currency');
        }
        if (order.amount_unit === 'MINOR' && settlementContext?.rail === 'internal') {
          throw new ApiPaymentConflictError('Pro renewal requires external funding');
        }
        let walletAmount = 0;
        let walletContributionMinor = 0;
        if (walletContributionEnabled && payerPartyId && walletAvailable > 0) {
          const fullValuation = await valuePointsK({
            sourceCurrency: order.currency,
            sourceAmountMinor: basketAmount,
            context: 'checkout-mixed',
          }, client);
          walletAmount = customWalletAmount !== undefined
            ? customWalletAmount
            : Math.min(walletAvailable, fullValuation.quantityK);
          if (walletAmount > walletAvailable) throw new ApiPaymentValidationError('walletPointsAmount exceeds wallet balance');
          if (walletAmount > fullValuation.quantityK) throw new ApiPaymentValidationError('walletPointsAmount exceeds checkout value');
          if (walletAmount > 0) {
            walletContributionMinor = walletAmount === fullValuation.quantityK
              ? basketAmount
              : Math.floor(Number((BigInt(basketAmount) * BigInt(walletAmount)) / BigInt(fullValuation.quantityK)));
          }
        }
        const externalPrincipal = Math.max(0, basketAmount - walletContributionMinor);
        const feeAmount = order.amount_unit === 'MINOR' || externalPrincipal === 0
          ? 0 : calculatePaymentFee(externalPrincipal, externalContext);
        const externalAmount = externalPrincipal + feeAmount;
        const totalAmount = basketAmount + feeAmount;
        const providerExpectedAmount = settlementContext?.rail === 'stripe'
          ? toStripeAmount(order.currency, externalPrincipal, order.amount_unit)
            // ERPNext Payment Request is the authoritative amount to collect.
            // Keep the existing provider fee policy for the other checkout flows.
            + (isErpnextPointsK ? 0
              : Math.round(toStripeAmount(order.currency, externalPrincipal, order.amount_unit) * externalContext.percentageBps / 10_000)
                + (externalPrincipal === 0 || externalContext.fixedAmount === 0 ? 0 : toStripeAmount(order.currency, externalContext.fixedAmount)))
          : null;
        const beneficiary = settlementContext?.regulatoryProfileId
          ? isWalletRecharge || order.business_purpose === 'pro_subscription_renewal'
            ? { beneficiaryType: 'NETWORK' as const, beneficiaryPartyId: null }
            : await this.resolvePaymentRequestBeneficiary(client, order.merchant_profile_id!)
          : null;
        const update = settlementContext?.regulatoryProfileId
         ? await client.query<ApiPaymentOrderRow>(
           `UPDATE konektag.api_payment_orders
            SET wallet_available_amount = $1, wallet_amount = $2, wallet_contribution_amount = $20, external_amount = $3, fee_amount = $4, total_amount = $5, tax_amount = $21,
                payer_party_id = $6, funding_state = 'prepared',
                 settlement_legal_entity_id = $7, settlement_regulatory_profile_id = $8, settlement_corridor_id = $9,
                  settlement_regulated_actor_id = $10, settlement_rail = $11, settlement_provider = $12, provider_configuration_key = $13,
                 payment_country = $14, beneficiary_type = $15, beneficiary_party_id = $16, provider_expected_amount = $17,
                  updated_at = now(), version = version + 1
              WHERE id = $18 AND version = $19
             RETURNING *`,
            [walletAvailable, walletAmount, externalAmount, feeAmount, totalAmount, payerPartyId,
              settlementContext.legalEntityId, settlementContext.regulatoryProfileId, settlementContext.corridorId,
                settlementContext.regulatedActorId, settlementContext.rail, settlementContext.provider, settlementContext.providerConfigurationKey,
                settlementContext.paymentCountry, beneficiary!.beneficiaryType, beneficiary!.beneficiaryPartyId, providerExpectedAmount, order.id, order.version, walletContributionMinor, taxAmount],
         )
         : await client.query<ApiPaymentOrderRow>(
           `UPDATE konektag.api_payment_orders
            SET wallet_available_amount = $1, wallet_amount = $2, external_amount = $3, fee_amount = $4, total_amount = $5,
                payer_party_id = $6, funding_state = 'prepared', updated_at = now(), version = version + 1
            WHERE id = $7 AND version = $8
            RETURNING *`,
           [walletAvailable, walletAmount, externalAmount, feeAmount, totalAmount, payerPartyId, order.id, order.version],
         );
       const updatedRows = update.rows;
      const updated = updatedRows[0];
      if (!updated) throw new ApiPaymentConflictError('Payment funding changed concurrently');
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async resolvePayerParty(client: DatabaseClient, payer: ApiPaymentPayer): Promise<string> {
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM konektag.parties WHERE keycloak_id = $1 AND is_active = true LIMIT 1`,
      [payer.keycloakId],
    );
    if (existing[0]) return existing[0].id;

    await client.query(
      `INSERT INTO konektag.parties (party_type, keycloak_id, display_name, email)
       VALUES ('individual', $1, $2, $3)
       ON CONFLICT (keycloak_id) DO NOTHING`,
      [payer.keycloakId, payer.username || payer.keycloakId, payer.email ?? null],
    );
    const { rows: created } = await client.query<{ id: string }>(
      `SELECT id FROM konektag.parties WHERE keycloak_id = $1 AND is_active = true LIMIT 1`,
      [payer.keycloakId],
    );
    if (!created[0]) throw new ApiPaymentConflictError('Unable to resolve the wallet payer');
    return created[0].id;
  },

  async assertPayerMatchesFunding(client: DatabaseClient, order: ApiPaymentOrderRow, payer?: ApiPaymentPayer): Promise<void> {
    if (!order.payer_party_id) return;
    if (!payer) throw new ApiPaymentConflictError('Checkout funding requires the wallet payer session');
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM konektag.parties WHERE keycloak_id = $1 AND is_active = true LIMIT 1`,
      [payer.keycloakId],
    );
    if (rows[0]?.id !== order.payer_party_id) {
      throw new ApiPaymentConflictError('Checkout funding belongs to another payer');
    }
  },

  async issueWalletAuthorization(token: string, payer: ApiPaymentPayer): Promise<{
    funding: ApiPaymentFunding;
    authorization: ApiPaymentWalletAuthorization;
    emailSent: boolean;
  }> {
    const order = await this.prepareFundingOrder(token, payer);
    if (order.environment !== 'live') {
      throw new ApiPaymentValidationError('Wallet authorization is only available for live checkouts');
    }
    if (Number(order.wallet_amount) <= 0 || !order.payer_party_id) {
      throw new ApiPaymentConflictError('This checkout has no Wallet contribution to authorize');
    }

    // An expired hold must not make an old approved OTP reusable for a new checkout attempt.
    await pool.query(
      `UPDATE konektag.api_payment_wallet_reservations
       SET lifecycle = 'expired', released_at = now(), release_reason = 'reservation_expired',
           updated_at = now(), version = version + 1
       WHERE payment_order_id = $1 AND lifecycle = 'active' AND expires_at <= now()`,
      [order.id],
    );
    await pool.query(
      `UPDATE konektag.wallet_debit_authorizations a
       SET lifecycle = 'expired', updated_at = now(), version = version + 1
       FROM konektag.api_payment_wallet_reservations r
       WHERE r.payment_order_id = $1 AND r.authorization_id = a.id
         AND r.lifecycle = 'expired' AND a.lifecycle = 'approved'`,
      [order.id],
    );
    const { rows: merchants } = await pool.query<{ business_name: string }>(
      `SELECT business_name FROM konektag.merchant_profiles
       WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [order.merchant_profile_id],
    );
    const result = await walletDebitAuthorizationService.issue({
      operationType: 'api_payment',
      operationId: order.id,
      amount: Number(order.wallet_amount),
      currency: 'K',
      payeeSnapshot: {
        displayName: merchants[0]?.business_name || 'Konektag merchant',
        reference: order.merchant_transaction_id,
      },
    }, {
      userId: payer.userId,
      email: payer.email || '',
      displayName: payer.username,
    } satisfies WalletDebitAuthorizationPayer);
    return {
      funding: toFunding(order),
      authorization: toCheckoutWalletAuthorization(result.authorization),
      emailSent: result.emailSent,
    };
  },

  async verifyWalletAuthorization(token: string, otp: string, payer: ApiPaymentPayer): Promise<{
    funding: ApiPaymentFunding;
    authorization: ApiPaymentWalletAuthorization;
  }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders WHERE checkout_token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');
      if (order.environment !== 'live') {
        throw new ApiPaymentValidationError('Wallet authorization is only available for live checkouts');
      }
      await this.assertPayerMatchesFunding(client, order, payer);
      if (Number(order.wallet_amount) <= 0 || !order.payer_party_id) {
        throw new ApiPaymentConflictError('This checkout has no Wallet contribution to authorize');
      }
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`api-payment-wallet-reservation:${order.payer_party_id}:K`],
      );
      await client.query(
        `UPDATE konektag.api_payment_wallet_reservations
         SET lifecycle = 'expired', released_at = now(), release_reason = 'reservation_expired',
             updated_at = now(), version = version + 1
         WHERE payer_party_id = $1 AND currency = 'K' AND lifecycle = 'active' AND expires_at <= now()`,
        [order.payer_party_id],
      );
      const { rows: existingRows } = await client.query<ApiPaymentWalletReservationRow>(
        `SELECT * FROM konektag.api_payment_wallet_reservations
         WHERE payment_order_id = $1 AND lifecycle = 'active' AND expires_at > now()
         FOR UPDATE`,
        [order.id],
      );
      const existing = existingRows[0];
      if (existing) {
        if (existing.authorization_id === '' || existing.payer_party_id !== order.payer_party_id
          || Number(existing.amount) !== Number(order.wallet_amount) || existing.currency !== 'K') {
          throw new ApiPaymentConflictError('Wallet reservation does not match checkout funding');
        }
        await client.query('COMMIT');
        return {
          funding: toFunding(order),
          authorization: {
            lifecycle: 'approved', amount: Number(existing.amount), currency: existing.currency,
            payeeName: 'Konektag merchant', expiresAt: new Date(existing.expires_at).toISOString(), approvedAt: null,
          },
        };
      }
      const authorization = await walletDebitAuthorizationService.verifyApiPayment(client, order.id, otp, payer.userId);
      if (authorization.amount !== Number(order.wallet_amount) || authorization.currency !== 'K') {
        throw new ApiPaymentConflictError('Wallet authorization does not match checkout funding');
      }
      const { rows: balances } = await client.query<{ balance: number | string }>(
        `SELECT GREATEST(0, COALESCE((
            SELECT SUM(CASE WHEN entry_side = 'credit' THEN amount ELSE -amount END)
            FROM konektag.ledger_entries WHERE party_id = $1 AND account_code = '1000' AND currency = 'K'
          ), 0) - COALESCE((
            SELECT SUM(amount) FROM konektag.api_payment_wallet_reservations
            WHERE payer_party_id = $1 AND currency = 'K' AND lifecycle = 'active' AND expires_at > now()
          ), 0)) AS balance`,
        [order.payer_party_id],
      );
      if (Number(balances[0]?.balance ?? 0) < Number(order.wallet_amount)) {
        throw new ApiPaymentConflictError('Wallet balance is no longer available for this checkout');
      }
      const { rows: reserved } = await client.query<ApiPaymentWalletReservationRow>(
        `INSERT INTO konektag.api_payment_wallet_reservations
           (payment_order_id, authorization_id, payer_party_id, amount, currency, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '30 minutes')
         RETURNING *`,
        [order.id, authorization.id, order.payer_party_id, order.wallet_amount, 'K'],
      );
      if (!reserved[0]) throw new ApiPaymentConflictError('Unable to reserve Wallet funding');
      await client.query('COMMIT');
      return { funding: toFunding(order), authorization: toCheckoutWalletAuthorization(authorization) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async requireActiveWalletAuthorization(client: DatabaseClient, order: ApiPaymentOrderRow): Promise<void> {
    if (Number(order.wallet_amount) === 0) return;
    if (!order.payer_party_id) throw new ApiPaymentConflictError('Wallet funding is missing its payer');
    await client.query(
      `UPDATE konektag.api_payment_wallet_reservations
       SET lifecycle = 'expired', released_at = now(), release_reason = 'reservation_expired',
           updated_at = now(), version = version + 1
       WHERE payment_order_id = $1 AND lifecycle = 'active' AND expires_at <= now()`,
      [order.id],
    );
    const { rows } = await client.query<ApiPaymentWalletReservationRow>(
      `SELECT r.* FROM konektag.api_payment_wallet_reservations r
       JOIN konektag.wallet_debit_authorizations a ON a.id = r.authorization_id
       WHERE r.payment_order_id = $1 AND r.payer_party_id = $2 AND r.amount = $3 AND r.currency = 'K'
         AND r.lifecycle = 'active' AND r.expires_at > now() AND a.lifecycle = 'approved'
       FOR UPDATE`,
      [order.id, order.payer_party_id, order.wallet_amount],
    );
    if (!rows[0]) throw new ApiPaymentConflictError('Wallet contribution requires an approved authorization');
  },

  async captureWalletAuthorization(client: DatabaseClient, order: ApiPaymentOrderRow): Promise<void> {
    if (Number(order.wallet_amount) === 0) return;
    await this.requireActiveWalletAuthorization(client, order);
    const { rows } = await client.query<ApiPaymentWalletReservationRow>(
      `UPDATE konektag.api_payment_wallet_reservations
       SET lifecycle = 'captured', captured_at = now(), updated_at = now(), version = version + 1
       WHERE payment_order_id = $1 AND lifecycle = 'active' AND expires_at > now()
       RETURNING *`,
      [order.id],
    );
    const reservation = rows[0];
    if (!reservation) throw new ApiPaymentConflictError('Wallet reservation is no longer capturable');
    const consumed = await client.query<{ id: string }>(
      `UPDATE konektag.wallet_debit_authorizations
       SET lifecycle = 'consumed', consumed_at = now(), updated_at = now(), version = version + 1
       WHERE id = $1 AND lifecycle = 'approved'`,
      [reservation.authorization_id],
    );
    if (!consumed.rows[0]) throw new ApiPaymentConflictError('Wallet authorization is no longer consumable');
  },

  async assertWalletAuthorizationForOrder(orderId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      if (!rows[0]) throw new ApiPaymentNotFoundError('Payment order not found');
      await this.requireActiveWalletAuthorization(client, rows[0]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async handleProviderAttemptFailure(orderId: string, providerReference: string): Promise<void> {
    const client = await pool.connect(); let recipient: string | null = null; let resumeToken: string | null = null;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow & { resume_token_hash: string | null }>(
        `SELECT * FROM konektag.api_payment_orders WHERE id=$1 FOR UPDATE`, [orderId]);
      const order = rows[0];
      if (!order || order.state === 'paid' || isTerminalState(order.state)) { await client.query('COMMIT'); return; }
      const attempt = await client.query<{ state:string }>(
        `SELECT state FROM konektag.payment_provider_attempts WHERE source_type='api_payment' AND source_id=$1 AND provider_reference=$2 FOR UPDATE`,
        [order.id,providerReference]);
      if (!attempt.rows[0] || !['failed','cancelled','expired'].includes(attempt.rows[0].state)) { await client.query('COMMIT'); return; }
      await client.query(`UPDATE konektag.api_payment_wallet_reservations SET lifecycle='expired',released_at=now(),release_reason='expired',updated_at=now(),version=version+1 WHERE payment_order_id=$1 AND lifecycle='active' AND expires_at<=now()`,[order.id]);
      const hold=await client.query(`SELECT 1 FROM konektag.api_payment_wallet_reservations WHERE payment_order_id=$1 AND lifecycle='active' AND expires_at>now() LIMIT 1`,[order.id]);
      if(Number(order.wallet_amount)>0&&!hold.rows[0]) await client.query(`UPDATE konektag.api_payment_orders SET wallet_amount=0,wallet_contribution_amount=0,wallet_available_amount=0,external_amount=subtotal_amount+tax_amount,fee_amount=0,total_amount=subtotal_amount+tax_amount,payer_party_id=NULL WHERE id=$1`,[order.id]);
      if(order.state==='processing'||order.state==='awaiting_mobile_money') await client.query(`UPDATE konektag.api_payment_orders SET state='pending',funding_state='prepared',payment_method=NULL,updated_at=now(),version=version+1 WHERE id=$1`,[order.id]);
      resumeToken=randomBytes(32).toString('base64url'); await client.query(`UPDATE konektag.api_payment_orders SET resume_token_hash=$2 WHERE id=$1`,[order.id,hashToken(resumeToken)]);
      recipient=order.payer_identity.includes('@')?order.payer_identity:null; await client.query('COMMIT');
    } catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e} finally{client.release()}
    const origin=process.env.PUBLIC_SITE_URL||process.env.PUBLIC_APP_URL; if(recipient&&resumeToken&&origin){const url=new URL(`/fr/pay/checkout/resume?resume=${encodeURIComponent(resumeToken)}`,origin).toString();await emailService.send({to:recipient,subject:'Votre paiement Konektag n’a pas pu être validé',html:`<p>Votre paiement n’a pas pu être validé.</p><p><a href="${url}">Reprendre mon paiement</a></p>`}).catch(()=>undefined)}
  },

  async exchangeResumeToken(resumeToken: string): Promise<{ checkoutToken: string }>{
    if(!resumeToken) throw new ApiPaymentNotFoundError('Checkout not found');
    // Resume tokens are deliberately one-way references. A fresh checkout bearer token is issued on exchange.
    const checkoutToken=randomBytes(32).toString('base64url');
    const {rows}=await pool.query<{id:string}>(`UPDATE konektag.api_payment_orders SET checkout_token_hash=$2,resume_token_hash=NULL,updated_at=now(),version=version+1 WHERE resume_token_hash=$1 AND state='pending' RETURNING id`,[hashToken(resumeToken),hashToken(checkoutToken)]);
    if(!rows[0]) throw new ApiPaymentNotFoundError('Resume link is invalid or expired');
    return {checkoutToken};
  },

  async reopenAfterTerminalProviderAttempt(token: string): Promise<ReturnType<typeof toPublicOrder>> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders WHERE checkout_token_hash=$1 FOR UPDATE`, [hashToken(token)]);
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');
      if (isCheckoutExpired(order)) {
        const expired = await this.updateState(client, order, 'expired');
        await client.query('COMMIT');
        return toPublicOrder(expired);
      }
      if (order.state !== 'processing' && order.state !== 'awaiting_mobile_money') {
        await client.query('COMMIT');
        return toPublicOrder(order);
      }
      await client.query(
        `UPDATE konektag.payment_provider_attempts SET state='expired',updated_at=now(),version=version+1
         WHERE source_type='api_payment' AND source_id=$1 AND state IN ('pending','processing')
           AND expires_at IS NOT NULL AND expires_at<=now()`, [order.id]);
      const { rows: active } = await client.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM konektag.payment_provider_attempts
          WHERE source_type='api_payment' AND source_id=$1 AND state IN ('pending','processing')
            AND (expires_at IS NULL OR expires_at>now())) AS present`, [order.id]);
      if (active[0]?.present) throw new ApiPaymentConflictError('A payment attempt is still active');
      const { rows: succeeded } = await client.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM konektag.payment_provider_attempts
          WHERE source_type='api_payment' AND source_id=$1 AND state='succeeded') AS present`, [order.id]);
      if (succeeded[0]?.present) throw new ApiPaymentConflictError('A provider payment is already confirmed');
      const updated = await this.updateState(client, order, 'pending', undefined, 'prepared');
      await client.query('COMMIT');
      await publishPaymentStatus(updated);
      return toPublicOrder(updated);
    } catch (error) {
      await client.query('ROLLBACK').catch(()=>undefined);
      throw error;
    } finally { client.release(); }
  },

  async getStripeOrder(token: string, payer?: ApiPaymentPayer, allowPaid = false, feeContext?: ApiPaymentExternalFundingContext): Promise<ApiPaymentStripeOrder> {
    const order = await this.prepareFundingOrder(token, payer, feeContext);
    if (order.environment !== 'live') {
      throw new ApiPaymentValidationError('Stripe card collection is only available for live checkouts');
    }
    if (order.state === 'paid' && !allowPaid) throw new ApiPaymentConflictError('Checkout has already been paid');
    if (order.state !== 'pending' && order.state !== 'processing' && order.state !== 'paid') {
      throw new ApiPaymentConflictError(`Checkout cannot collect a card payment while ${order.state}`);
    }
    if ((order.state === 'processing' || order.state === 'paid') && order.payment_method !== 'card') {
      throw new ApiPaymentConflictError('Checkout is being processed by another payment method');
    }
    if (order.external_amount === 0) {
      throw new ApiPaymentConflictError('Wallet fully covers this checkout');
    }
    if (order.provider_configuration_key && (!Number.isSafeInteger(Number(order.provider_expected_amount)) || Number(order.provider_expected_amount) <= 0)) {
      throw new ApiPaymentConflictError('Stripe provider expected amount is missing');
    }
    if (Number(order.wallet_amount) > 0) await this.assertWalletAuthorizationForOrder(order.id);
    if (order.settlement_regulatory_profile_id || order.beneficiary_type) this.assertPaymentRequestFrozen(order, 'stripe');
    return {
      id: order.id,
      merchantTransactionId: order.merchant_transaction_id,
      currency: order.currency,
      totalAmount: order.total_amount,
      externalAmount: order.external_amount,
      providerExpectedAmount: order.provider_expected_amount ?? toStripeAmount(order.currency, order.external_amount, order.amount_unit),
      stripePaymentIntentId: order.stripe_payment_intent_id,
      providerConfigurationKey: order.provider_configuration_key,
    };
  },
  async getMobileMoneyOrder(token: string, payer?: ApiPaymentPayer, feeContext?: ApiPaymentExternalFundingContext): Promise<ApiPaymentMobileMoneyOrder> {
    const order = await this.prepareFundingOrder(token, payer, feeContext);
    if (order.environment !== 'live' || order.state === 'paid' || order.external_amount === 0) throw new ApiPaymentConflictError('Checkout cannot collect Mobile Money');
    if (order.state !== 'pending' && order.state !== 'processing' && order.state !== 'awaiting_mobile_money') throw new ApiPaymentConflictError(`Checkout cannot collect Mobile Money while ${order.state}`);
    if ((order.state === 'processing' || order.state === 'awaiting_mobile_money') && order.payment_method !== 'mobile_money') throw new ApiPaymentConflictError('Checkout is being processed by another payment method');
    if (Number(order.wallet_amount) > 0) await this.assertWalletAuthorizationForOrder(order.id);
    this.assertPaymentRequestFrozen(order, 'mobile_money');
    if (order.settlement_provider !== 'pawapay') throw new ApiPaymentConflictError('Checkout is not configured for PawaPay');
    const paymentCountry = ({ CM: 'CMR', CG: 'COG', GA: 'GAB' } as const)[order.payment_country ?? ''];
    if (!paymentCountry || order.currency !== 'XAF') throw new ApiPaymentConflictError('Checkout is not configured for a supported PawaPay XAF country');
    return { id: order.id, currency: order.currency, externalAmount: order.external_amount, paymentCountry, providerConfigurationKey: order.provider_configuration_key };
  },

  async attachStripePaymentIntent(token: string, paymentIntentId: string): Promise<ApiPaymentStripeOrder> {
    if (!paymentIntentId.startsWith('pi_')) {
      throw new ApiPaymentValidationError('Invalid Stripe PaymentIntent ID');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders WHERE checkout_token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');
      if (order.environment !== 'live') {
        throw new ApiPaymentValidationError('Stripe card collection is only available for live checkouts');
      }
      if (order.settlement_regulatory_profile_id || order.beneficiary_type) this.assertPaymentRequestFrozen(order, 'stripe');
      if (!order.beneficiary_type) await this.resolveBeneficiaryType(client, order.merchant_profile_id!);
      if (order.state === 'paid') throw new ApiPaymentConflictError('Checkout has already been paid');
      if (order.state !== 'pending' && order.state !== 'processing') {
        throw new ApiPaymentConflictError(`Checkout cannot collect a card payment while ${order.state}`);
      }
      if (order.stripe_payment_intent_id && order.stripe_payment_intent_id !== paymentIntentId) {
        const active = await client.query<{ present: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM konektag.payment_provider_attempts
           WHERE source_type='api_payment' AND source_id=$1
             AND state IN ('pending','processing') AND (expires_at IS NULL OR expires_at>now())) AS present`,
          [order.id],
        );
        if (active.rows[0]?.present) throw new ApiPaymentConflictError('Another payment attempt is still active');
      }
      if (order.state === 'processing' && order.payment_method !== 'card') {
        const active = await client.query<{ present: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM konektag.payment_provider_attempts
           WHERE source_type='api_payment' AND source_id=$1
             AND state IN ('pending','processing') AND (expires_at IS NULL OR expires_at>now())) AS present`,
          [order.id],
        );
        if (active.rows[0]?.present) throw new ApiPaymentConflictError('Another payment attempt is still active');
      }
      if (order.funding_state !== 'prepared' && order.funding_state !== 'external_started') {
        throw new ApiPaymentConflictError('Checkout funding has not been prepared');
      }
      if (order.external_amount === 0) {
        throw new ApiPaymentConflictError('Wallet fully covers this checkout');
      }
      await this.requireActiveWalletAuthorization(client, order);
      assertTransition(order.state, 'processing');

      if (order.stripe_payment_intent_id === paymentIntentId && order.state === 'processing') {
        await client.query('COMMIT');
        return {
          id: order.id,
          merchantTransactionId: order.merchant_transaction_id,
          currency: order.currency,
          totalAmount: order.total_amount,
          externalAmount: order.external_amount,
          providerExpectedAmount: order.provider_expected_amount ?? toStripeAmount(order.currency, order.external_amount, order.amount_unit),
          stripePaymentIntentId: order.stripe_payment_intent_id,
          providerConfigurationKey: order.provider_configuration_key,
        };
      }

      const { rows: updatedRows } = await client.query<ApiPaymentOrderRow>(
         `UPDATE konektag.api_payment_orders
          SET state = 'processing', payment_method = 'card', stripe_payment_intent_id = $1,
              funding_state = 'external_started', updated_at = now(), version = version + 1
         WHERE id = $2 AND version = $3
         RETURNING *`,
        [paymentIntentId, order.id, order.version],
      );
       const updated = updatedRows[0];
       if (!updated) throw new ApiPaymentConflictError('Payment state changed concurrently');
       await client.query('COMMIT');
       await publishPaymentStatus(updated);
       return {
        id: updated.id,
        merchantTransactionId: updated.merchant_transaction_id,
        currency: updated.currency,
        totalAmount: updated.total_amount,
        externalAmount: updated.external_amount,
        providerExpectedAmount: updated.provider_expected_amount ?? toStripeAmount(updated.currency, updated.external_amount, updated.amount_unit),
          stripePaymentIntentId: updated.stripe_payment_intent_id,
          providerConfigurationKey: updated.provider_configuration_key,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async confirmCheckout(token: string, paymentMethod: ApiPaymentMethod, payer?: ApiPaymentPayer) {
    if (paymentMethod === 'wallet') {
      const order = await this.prepareFundingOrder(token, payer);
      if (order.environment !== 'live') {
        throw new ApiPaymentValidationError('Wallet payments are only available for live checkouts');
      }
      if (order.external_amount !== 0) {
        throw new ApiPaymentConflictError('Wallet does not fully cover this checkout');
      }
      const finalOrder = await this.markFinalAndDispatch(order.id, 'wallet');
      return { outcome: 'paid' as const, order: finalOrder };
    }

    if (paymentMethod === 'mobile_money') {
      await this.prepareFundingOrder(token, payer);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders WHERE checkout_token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');

      if (order.environment === 'sandbox') {
        if (paymentMethod !== 'sandbox') {
          throw new ApiPaymentValidationError('Sandbox checkouts must use the sandbox payment method');
        }
        if (order.state === 'paid') {
          if (!order.merchant_profile_id) throw new ApiPaymentConflictError('Sandbox checkout requires a merchant');
          const deliveryId = await apiPaymentWebhookService.enqueuePaymentSucceeded(client, order as typeof order & { merchant_profile_id: string });
          await client.query('COMMIT');
          if (deliveryId) await apiPaymentWebhookService.deliverPaymentSucceeded(deliveryId)
            .catch(error => console.error('[api-payment-webhook] Immediate sandbox delivery failed', error));
          return { outcome: 'paid' as const, order: toPublicOrder(order) };
        }
        assertTransition(order.state, 'paid');
        const updated = await this.updateState(client, order, 'paid', 'sandbox');
        if (!updated.merchant_profile_id) throw new ApiPaymentConflictError('Sandbox checkout requires a merchant');
        const deliveryId = await apiPaymentWebhookService.enqueuePaymentSucceeded(client, updated as typeof updated & { merchant_profile_id: string });
        await client.query('COMMIT');
        await publishPaymentStatus(updated);
        if (deliveryId) await apiPaymentWebhookService.deliverPaymentSucceeded(deliveryId)
          .catch(error => console.error('[api-payment-webhook] Immediate sandbox delivery failed', error));
        return { outcome: 'paid' as const, order: toPublicOrder(updated) };
      }

      if (paymentMethod === 'mobile_money') {
        if (order.state === 'paid') {
          await client.query('COMMIT');
          return { outcome: 'paid' as const, order: toPublicOrder(order) };
        }
        if (order.state === 'awaiting_mobile_money') {
          await client.query('COMMIT');
          return { outcome: 'awaiting_mobile_money' as const, order: toPublicOrder(order) };
        }
        if (order.external_amount === 0) {
          throw new ApiPaymentConflictError('Wallet fully covers this checkout');
        }
        if (order.funding_state !== 'prepared' && order.funding_state !== 'external_started') {
          throw new ApiPaymentConflictError('Checkout funding has not been prepared');
        }
        await this.requireActiveWalletAuthorization(client, order);
        assertTransition(order.state, 'awaiting_mobile_money');
        const updated = await this.updateState(client, order, 'awaiting_mobile_money', 'mobile_money', 'external_started');
        await client.query('COMMIT');
        await publishPaymentStatus(updated);
        return { outcome: 'awaiting_mobile_money' as const, order: toPublicOrder(updated) };
      }

      if (paymentMethod === 'card') {
        throw new ApiPaymentConflictError('Stripe collection must be started by a dedicated endpoint');
      }
      throw new ApiPaymentValidationError('Live checkouts support wallet, card, or mobile_money');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async cancelCheckout(token: string): Promise<ReturnType<typeof toPublicOrder>> {
    if (!token) throw new ApiPaymentNotFoundError('Checkout not found');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT o.*, mp.business_name AS merchant_name, mp.logo_url AS merchant_logo_url
         FROM konektag.api_payment_orders o
         LEFT JOIN konektag.merchant_profiles mp ON mp.id = o.merchant_profile_id AND mp.deleted_at IS NULL
         WHERE o.checkout_token_hash = $1
         LIMIT 1
         FOR UPDATE OF o`,
        [hashToken(token)],
      );
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Checkout not found');

      if (order.state === 'paid') {
        throw new ApiPaymentConflictError('Paid checkouts cannot be cancelled');
      }
      if (isTerminalState(order.state)) {
        await client.query('COMMIT');
        return toPublicOrder(order);
      }

      const updated = await this.updateState(client, order, 'cancelled');
      await client.query('COMMIT');
      await publishPaymentStatus(updated);
      return toPublicOrder(updated);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async updateState(
    client: DatabaseClient,
    order: ApiPaymentOrderRow,
    state: ApiPaymentState,
    paymentMethod?: ApiPaymentMethod,
    fundingState?: ApiPaymentFundingState,
  ): Promise<ApiPaymentOrderRow> {
    assertTransition(order.state, state);
    const { rows } = await client.query<ApiPaymentOrderRow>(
      `UPDATE konektag.api_payment_orders
       SET state = $1,
             payment_method = COALESCE($2, payment_method),
             funding_state = COALESCE($3, funding_state),
             paid_at = CASE WHEN $6 THEN now() ELSE paid_at END,
            updated_at = now(),
            version = version + 1
        WHERE id = $4 AND version = $5
        RETURNING *`,
      [state, paymentMethod ?? null, fundingState ?? null, order.id, order.version, state === 'paid'],
    );
    if (!rows[0]) throw new ApiPaymentConflictError('Payment state changed concurrently');
    if (state !== 'paid' && rows[0].merchant_profile_id) {
      const event = `payment.${state}` as ApiPaymentWebhookEvent;
      await apiPaymentWebhookService.enqueuePaymentEvent(client, rows[0] as PaymentWebhookOrder, event);
    }
    return rows[0];
  },

  async resolveMerchantSettlementContext(
    client: DatabaseClient,
    order: ApiPaymentOrderRow,
    paymentMethod: Extract<ApiPaymentMethod, 'wallet' | 'card' | 'mobile_money'>,
  ): Promise<ApiPaymentSettlementContext> {
    const rail = paymentMethod === 'card' ? 'stripe' : paymentMethod === 'mobile_money' ? 'mobile_money' : 'internal';
    if (!order.settlement_legal_entity_id || !order.settlement_regulatory_profile_id
      || !order.settlement_corridor_id || order.settlement_rail !== rail) {
      // Legacy orders predate the selected Frappe context. New Checkout orders
      // always persist it during funding and never reach this compatibility path.
      const { rows } = await client.query<ApiPaymentSettlementContext & { profile_count: string }>(
        `SELECT p.id AS "merchantPartyId", mp.legal_entity_id AS "legalEntityId",
                MIN(rp.id)::text AS "regulatoryProfileId", MIN(rp.corridor_id)::text AS "corridorId",
                COUNT(rp.id)::text AS profile_count
         FROM konektag.merchant_profiles mp
          JOIN konektag.users u ON u.id = mp.user_id AND u.deleted_at IS NULL
          JOIN konektag.parties p ON p.keycloak_id = u.keycloak_id AND p.party_type = 'merchant' AND p.is_active = true
          JOIN konektag.legal_entities le ON le.id = mp.legal_entity_id AND le.status = 'APPROVED' AND le.deleted_at IS NULL
          LEFT JOIN konektag.regulatory_profiles rp ON rp.legal_entity_id = le.id
            AND rp.authorized_operation = 'link_payment' AND rp.rail = $2 AND rp.status = 'APPROVED' AND rp.deleted_at IS NULL
         WHERE mp.id = $1 AND mp.deleted_at IS NULL GROUP BY p.id, mp.legal_entity_id`,
        [order.merchant_profile_id, rail],
      );
      if (!rows[0] || Number(rows[0].profile_count) !== 1 || !rows[0].regulatoryProfileId) {
        throw new ApiPaymentConflictError('Merchant legal entity and regulatory profile must resolve unambiguously');
      }
      return rows[0];
    }
    if (order.beneficiary_type !== 'MERCHANT' || !order.beneficiary_party_id) {
      throw new ApiPaymentConflictError('Payment Request merchant beneficiary is missing');
    }
    return {
      merchantPartyId: order.beneficiary_party_id,
      legalEntityId: order.settlement_legal_entity_id,
      regulatoryProfileId: order.settlement_regulatory_profile_id,
      corridorId: order.settlement_corridor_id,
    };
  },

  async resolveBeneficiaryType(client: DatabaseClient, merchantProfileId: string): Promise<MerchantBeneficiaryType> {
    const { rows } = await client.query<{ beneficiary_type: MerchantBeneficiaryType }>(
      `SELECT beneficiary_type
       FROM konektag.merchant_profiles
       WHERE id = $1 AND deleted_at IS NULL
       FOR SHARE`,
      [merchantProfileId],
    );
    const beneficiaryType = rows[0]?.beneficiary_type;
    if (beneficiaryType !== 'MERCHANT' && beneficiaryType !== 'NETWORK') {
      throw new ApiPaymentConflictError('Merchant beneficiary type must resolve unambiguously');
    }
    return beneficiaryType;
  },

  async resolveNetworkSettlementContext(
    client: DatabaseClient,
    order: ApiPaymentOrderRow,
    paymentMethod: Extract<ApiPaymentMethod, 'wallet' | 'card' | 'mobile_money'>,
  ): Promise<ApiPaymentSettlementContext> {
    const rail = paymentMethod === 'card' ? 'stripe' : paymentMethod === 'mobile_money' ? 'mobile_money' : 'internal';
    if (!order.settlement_legal_entity_id || !order.settlement_regulatory_profile_id
      || !order.settlement_corridor_id || order.settlement_rail !== rail) {
      const { rows } = await client.query<Omit<ApiPaymentSettlementContext, 'merchantPartyId'> & { profile_count: string }>(
        `SELECT mp.legal_entity_id AS "legalEntityId", MIN(rp.id)::text AS "regulatoryProfileId",
                MIN(rp.corridor_id)::text AS "corridorId", COUNT(rp.id)::text AS profile_count
         FROM konektag.merchant_profiles mp
          JOIN konektag.legal_entities le ON le.id = mp.legal_entity_id AND le.status = 'APPROVED' AND le.deleted_at IS NULL
          LEFT JOIN konektag.regulatory_profiles rp ON rp.legal_entity_id = le.id
            AND rp.authorized_operation = 'link_payment' AND rp.rail = $2 AND rp.status = 'APPROVED' AND rp.deleted_at IS NULL
         WHERE mp.id = $1 AND mp.deleted_at IS NULL GROUP BY mp.legal_entity_id`,
        [order.merchant_profile_id, rail],
      );
      if (!rows[0] || Number(rows[0].profile_count) !== 1 || !rows[0].regulatoryProfileId) {
        throw new ApiPaymentConflictError('Network legal entity and regulatory profile must resolve unambiguously');
      }
      return { ...rows[0], merchantPartyId: '' };
    }
    return {
      merchantPartyId: '',
      legalEntityId: order.settlement_legal_entity_id,
      regulatoryProfileId: order.settlement_regulatory_profile_id,
      corridorId: order.settlement_corridor_id,
    };
  },

  async resolvePaymentRequestBeneficiary(
    client: DatabaseClient,
    merchantProfileId: string,
  ): Promise<{ beneficiaryType: MerchantBeneficiaryType; beneficiaryPartyId: string | null }> {
    const { rows } = await client.query<{
      beneficiary_type: MerchantBeneficiaryType;
      merchant_party_id: string | null;
    }>(
      `SELECT mp.beneficiary_type,
              p.id AS merchant_party_id
       FROM konektag.merchant_profiles mp
       LEFT JOIN konektag.users u ON u.id = mp.user_id AND u.deleted_at IS NULL
       LEFT JOIN konektag.parties p ON p.keycloak_id = u.keycloak_id
         AND p.party_type = 'merchant' AND p.is_active = true
       WHERE mp.id = $1 AND mp.deleted_at IS NULL`,
      [merchantProfileId],
    );
    const beneficiary = rows[0];
    if (!beneficiary || (beneficiary.beneficiary_type !== 'MERCHANT' && beneficiary.beneficiary_type !== 'NETWORK')) {
      throw new ApiPaymentConflictError('Payment Request beneficiary type must resolve unambiguously');
    }
    if (beneficiary.beneficiary_type === 'MERCHANT' && !beneficiary.merchant_party_id) {
      throw new ApiPaymentConflictError('Merchant party must resolve before provider payment starts');
    }
    return {
      beneficiaryType: beneficiary.beneficiary_type,
      beneficiaryPartyId: beneficiary.beneficiary_type === 'MERCHANT' ? beneficiary.merchant_party_id : null,
    };
  },

  assertPaymentRequestFrozen(order: ApiPaymentOrderRow, rail: string): void {
    if (!order.settlement_legal_entity_id || !order.settlement_regulatory_profile_id || !order.settlement_corridor_id
      || order.settlement_rail !== rail || !order.settlement_provider || !order.beneficiary_type
      || (order.beneficiary_type === 'MERCHANT' && !order.beneficiary_party_id)) {
      throw new ApiPaymentConflictError('Checkout Payment Request has not been frozen');
    }
  },

  async resolveNetworkAccountingGuide(
    client: DatabaseClient,
    legalEntityId: string,
    operation: NetworkAccountingOperation,
  ): Promise<NetworkAccountingGuide> {
    const { rows } = await client.query<{ debit_account: string; credit_account: string }>(
      `SELECT debit_account, credit_account
       FROM konektag.accounting_entry_guides
       WHERE legal_entity_id = $1 AND event_type = $2 AND is_active = true
         AND deleted_at IS NULL AND valid_from <= CURRENT_DATE
         AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
       LIMIT 2`,
      [legalEntityId, operation],
    );
    if (rows.length !== 1) throw new ApiPaymentNetworkOperationGuideRequiredError(operation);
    return { debitAccount: rows[0].debit_account, creditAccount: rows[0].credit_account };
  },

  async createMerchantSale(client: DatabaseClient, order: ApiPaymentOrderRow, financialTransactionId: string, context: ApiPaymentSettlementContext): Promise<void> {
    // Partner Checkout never charges a Konektag merchant commission. Provider/user fees are
    // separate funding dimensions and must not reduce the merchant's commercial sale.
    const netAmount = Number(order.total_amount);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO konektag.merchant_sales
        (sale_ref, merchant_profile_id, legal_entity_id, transaction_id, gross_amount, net_amount, tax_amount, commission_amount, currency, status, amount_unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'CREATED', $9)
       ON CONFLICT (sale_ref) DO NOTHING
       RETURNING id`,
      [`API-PAYMENT-${order.id}`, order.merchant_profile_id, context.legalEntityId, financialTransactionId,
       order.total_amount, netAmount, order.tax_amount, order.currency, order.amount_unit],
    );
    if (!rows[0]) return;
    await client.query(
      `INSERT INTO konektag.outbox_events
        (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ($1, 'MerchantSale', $2, 'MERCHANT_SALE_CREATED', 1, $3)`,
      [order.id, rows[0].id, JSON.stringify({
        Amount: netAmount,
        Currency: order.currency,
        ValueDate: new Date().toISOString().slice(0, 10),
        SourceReference: order.id,
        MerchantSaleId: rows[0].id,
        MerchantId: order.merchant_profile_id,
        LegalEntity: context.legalEntityId,
        RegulatoryProfileId: context.regulatoryProfileId,
      })],
    );
  },

  async confirmWalletRecharge(client: import('pg').PoolClient, order: ApiPaymentOrderRow, paymentMethod: Extract<ApiPaymentMethod, 'card' | 'mobile_money'>, providerReference: string, providerEventId: string): Promise<string> {
    if (!order.target_user_id || order.beneficiary_type !== 'NETWORK' || order.beneficiary_party_id) {
      throw new ApiPaymentConflictError('Wallet recharge payment request is invalid');
    }
    this.assertPaymentRequestFrozen(order, paymentMethod === 'card' ? 'stripe' : 'mobile_money');

    const { rows:[attempt] } = await client.query<{id:string; expected_amount:string; provider:string}>(
      `SELECT id,expected_amount,provider FROM konektag.payment_provider_attempts
       WHERE source_type='api_payment' AND source_id::text=$1::text
         AND provider_reference=$2 AND state='succeeded'
       FOR UPDATE`,
      [order.id, providerReference],
    );
    if (!attempt) throw new ApiPaymentConflictError('Wallet recharge successful provider attempt is missing');
    const allowedProviders = paymentMethod === 'card' ? ['stripe','manual'] : ['pawapay','manual'];
    if (!allowedProviders.includes(attempt.provider)) throw new ApiPaymentConflictError('Wallet recharge provider mismatch');

    const digits = minorDigits(order.currency);
    const lotValueMinor = Math.round(Number(order.subtotal_amount) * (10 ** digits));
    // Points K are EUR-denominated: 1 K = 1 EUR. Never equate a foreign
    // currency nominal amount (e.g. 9,000 XAF) with the number of K acquired.
    // Use the same authoritative FX valuation service as the rest of the wallet.
    const valuation = await valuePointsK({
      sourceCurrency: order.currency,
      sourceAmountMinor: lotValueMinor,
      context: 'wallet-recharge-acquisition',
    }, client);
    if (!Number.isSafeInteger(valuation.quantityK) || valuation.quantityK <= 0) {
      throw new ApiPaymentConflictError('Wallet recharge valuation did not produce a valid Points K quantity');
    }
    const result = await confirmPointsAcquisition(client, {
      orderId: order.id,
      userId: order.target_user_id,
      provider: attempt.provider as 'stripe'|'pawapay'|'manual',
      providerReference,
      providerEventId,
      attemptId: attempt.id,
      confirmedMinor: Number(attempt.expected_amount),
      currency: order.currency,
      pointsQuantity: valuation.quantityK,
      lotValueMinor,
      legalEntityId: order.settlement_legal_entity_id!,
      corridorId: order.settlement_corridor_id!,
      regulatoryProfileId: order.settlement_regulatory_profile_id!,
    });
    return result.transactionId;
  },

  async markFinalAndDispatch(orderId: string, paymentMethod: Extract<ApiPaymentMethod, 'wallet' | 'card' | 'mobile_money'>, providerReference?: string, providerEventId?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ApiPaymentOrderRow>(
        `SELECT * FROM konektag.api_payment_orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = rows[0];
      if (!order) throw new ApiPaymentNotFoundError('Payment order not found');
      if (order.environment !== 'live') throw new ApiPaymentValidationError('Provider confirmation is only valid for live payments');
      if (paymentMethod !== 'wallet') {
        if (!providerReference) throw new ApiPaymentConflictError('Provider confirmation reference is required');
        const allowedProviders = paymentMethod === 'card' ? ['stripe','manual'] : ['pawapay','manual'];
        const { rows: attempts } = await client.query<{ id: string; state: string; provider:string }>(
          `SELECT id,state,provider FROM konektag.payment_provider_attempts
           WHERE source_type='api_payment' AND source_id::text=$1::text AND provider_reference=$2
           FOR UPDATE`,
          [order.id, providerReference],
        );
        const provider = attempts[0]?.provider;
        if (!provider || !allowedProviders.includes(provider)) {
          throw new ApiPaymentConflictError('Provider attempt does not match payment method');
        }
        if (!attempts[0] || attempts[0].state !== 'succeeded') {
          throw new ApiPaymentConflictError('Provider attempt is not confirmed');
        }
        const { rows: otherSuccesses } = await client.query<{ provider_reference: string }>(
          `SELECT provider_reference FROM konektag.payment_provider_attempts
           WHERE source_type='api_payment' AND source_id=$1 AND state='succeeded'
             AND NOT (provider=$2 AND provider_reference=$3)
           LIMIT 1 FOR UPDATE`,
          [order.id, provider, providerReference],
        );
        if (otherSuccesses[0]) {
          throw new ApiPaymentConflictError('Checkout already has another successful provider attempt');
        }
        // A replay of the same successful provider reference is expected and must be
        // allowed through so resumable post-payment work (notably wallet recharge
        // acquisition in CONFIRMED_PENDING_USER_GL) can complete idempotently.
        if (order.state === 'paid' && order.order_purpose !== 'wallet_recharge') {
          return toPublicOrder(order);
        }
      }

      let finalOrder = order;
      let transitioned = false;
      let financialTransactionId: string | undefined;
      let deliveryId: string | null = null;

      // Paid wallet recharges created by the retired acquisition path still need
      // their canonical Points K acquisition. A verified provider event is enough
      // to resume this idempotently without charging the provider again.
      if (order.state === 'paid' && order.order_purpose === 'wallet_recharge') {
        if (paymentMethod === 'wallet' || !providerReference || !providerEventId) {
          throw new ApiPaymentConflictError('Wallet recharge requires verified external payment evidence');
        }
        const { rows:[pointsAcquisition] } = await client.query<{status:string}>(
          `SELECT status FROM konektag.points_acquisitions WHERE order_id=$1 FOR UPDATE`, [order.id]);
        if (pointsAcquisition?.status !== 'completed') {
          financialTransactionId = await this.confirmWalletRecharge(client, order, paymentMethod, providerReference, providerEventId);
        }
      }

      if (order.state !== 'paid') {
        if (order.funding_state === 'unprepared') {
          throw new ApiPaymentConflictError('Checkout funding has not been prepared');
        }
        if (paymentMethod === 'wallet') {
          if (order.external_amount !== 0) throw new ApiPaymentConflictError('Wallet does not fully cover this checkout');
        } else {
          if (order.external_amount === 0) throw new ApiPaymentConflictError('Wallet fully covers this checkout');
          if (order.payment_method !== paymentMethod || order.funding_state !== 'external_started') {
            throw new ApiPaymentConflictError('Checkout is not awaiting this payment provider');
          }
        }

        await this.requireActiveWalletAuthorization(client, order);
        const isWalletRecharge = order.order_purpose === 'wallet_recharge';
        const isProRenewal = order.business_purpose === 'pro_subscription_renewal';
        const beneficiaryType = isProRenewal || isWalletRecharge ? 'NETWORK' : order.beneficiary_type ?? await this.resolveBeneficiaryType(client, order.merchant_profile_id!);
        if (isProRenewal) {
          if (paymentMethod === 'wallet' || order.amount_unit !== 'MINOR'
            || Number(order.wallet_amount) !== 0 || !order.settlement_legal_entity_id) {
            throw new ApiPaymentConflictError('Invalid Pro renewal payment context');
          }
          const { rows: [renewalIntent] } = await client.query<{ merchant_profile_id: string }>(
            `SELECT merchant_profile_id FROM konektag.merchant_pro_renewal_intents
             WHERE payment_order_id=$1 AND status='PENDING' FOR UPDATE`, [order.id]);
          if (!renewalIntent || renewalIntent.merchant_profile_id !== order.order_metadata?.merchantProfileId) {
            throw new ApiPaymentConflictError('Pro renewal buyer does not match its payment intent');
          }
          const amount = Number(order.total_amount);
          const accountingResult = await accountingService.postTransaction({
            idempotencyKey: `pro-subscription:${order.id}`, transactionType: 'fee_collection',
            businessReference: order.id, currency: order.currency, amountUnit: 'MINOR',
            metadata: { legalEntityId: order.settlement_legal_entity_id,
              regulatoryProfileId: order.settlement_regulatory_profile_id,
              corridorId: order.settlement_corridor_id,
              regulatedActorId: order.settlement_regulated_actor_id,
              operationId: order.id,
              merchantProfileId: renewalIntent.merchant_profile_id },
            entries: [
              { accountCode: '7000', side: 'debit', amount, description: `Pro renewal ${order.id}` },
              { accountCode: '3000', side: 'credit', amount, description: `Pro renewal ${order.id}` },
            ],
          }, client);
          if (!accountingResult.success) throw new ApiPaymentConflictError(accountingResult.error || 'Pro accounting failed');
          financialTransactionId = accountingResult.financialTransactionId;
        } else if (beneficiaryType === 'MERCHANT') {
          const settlementContext = await this.resolveMerchantSettlementContext(client, order, paymentMethod);
          if (paymentMethod === 'wallet') {
            const { rows: [payer] } = await client.query<{ id: string }>(
              `SELECT u.id FROM konektag.parties p
               JOIN konektag.users u ON u.keycloak_id = p.keycloak_id AND u.deleted_at IS NULL
               WHERE p.id = $1 AND p.is_active = true`, [order.payer_party_id]);
            if (!payer) throw new ApiPaymentConflictError('Points K payer is unavailable');
            const pointsResult = await consumptionService.consumeAtMerchant({
              idempotencyKey: `API-PAYMENT:${order.id}`, userId: payer.id,
              merchantProfileId: order.merchant_profile_id!, amount: Number(order.total_amount),
              quantityK: Number(order.wallet_amount), currency: order.currency,
              merchantSaleRef: `API-PAYMENT-${order.id}`, rail: 'internal', paymentCountry: order.payment_country,
            }, client);
            if (!pointsResult.success || !pointsResult.financialTransactionId) {
              throw new ApiPaymentConflictError(pointsResult.error || 'Unable to consume Points K');
            }
            financialTransactionId = pointsResult.financialTransactionId;
          } else {
            const accountingResult = await accountingService.postTransaction(
              buildApiPaymentAccountingCommand(order, paymentMethod, settlementContext), client,
            );
            if (!accountingResult.success) throw new ApiPaymentConflictError(accountingResult.error || 'Unable to post payment accounting');
            financialTransactionId = accountingResult.financialTransactionId;
            await this.createMerchantSale(client, order, financialTransactionId, settlementContext);
          }
        } else if (isWalletRecharge) {
          if (paymentMethod === 'wallet' || !providerReference || !providerEventId) {
            throw new ApiPaymentConflictError('Wallet recharge requires verified external payment evidence');
          }
          financialTransactionId = await this.confirmWalletRecharge(client, order, paymentMethod, providerReference, providerEventId);
        } else {
          const context = await this.resolveNetworkSettlementContext(client, order, paymentMethod);
          const acquisitionGuide = await this.resolveNetworkAccountingGuide(client, context.legalEntityId, 'acquisition');
          const acquisition = await accountingService.postTransaction(
            buildNetworkApiPaymentAccountingCommand(order, paymentMethod, context, 'acquisition', acquisitionGuide), client,
          );
          if (!acquisition.success) throw new ApiPaymentConflictError(acquisition.error || 'Unable to post network acquisition accounting');
          financialTransactionId = acquisition.financialTransactionId;
          if (Number(order.fee_amount) > 0) {
            const feeGuide = await this.resolveNetworkAccountingGuide(client, context.legalEntityId, 'fee_collection');
            const fee = await accountingService.postTransaction(
              buildNetworkApiPaymentAccountingCommand(order, paymentMethod, context, 'fee_collection', feeGuide), client,
            );
            if (!fee.success) throw new ApiPaymentConflictError(fee.error || 'Unable to post network fee accounting');
          }
        }
        if (paymentMethod !== 'wallet') await this.captureWalletAuthorization(client, order);
        finalOrder = await this.updateState(client, order, 'paid', paymentMethod, 'finalized');
        if (isProRenewal) {
          await new MerchantProSubscriptionService(pool).applyPaidRenewal(order.id, client);
        } else if (beneficiaryType === 'MERCHANT') {
          if (!finalOrder.merchant_profile_id) throw new ApiPaymentConflictError('Merchant payment requires a merchant');
          deliveryId = await apiPaymentWebhookService.enqueuePaymentSucceeded(client, finalOrder as typeof finalOrder & { merchant_profile_id: string });
        }
        transitioned = true;
      }
      await client.query('COMMIT');
       if (finalOrder.payer_party_id) {
        const { rows: activationUsers } = await pool.query<{ id: string; country: string | null }>(
          `SELECT u.id, mp.country
           FROM konektag.parties p
           JOIN konektag.users u ON u.keycloak_id = p.keycloak_id AND u.deleted_at IS NULL
           JOIN konektag.merchant_profiles mp ON mp.id = $2 AND mp.deleted_at IS NULL
           WHERE p.id = $1 AND p.is_active = true`,
          [finalOrder.payer_party_id, finalOrder.merchant_profile_id],
        );
        if (activationUsers[0]) {
          if (!financialTransactionId) {
            const { rows: financialTransactions } = await pool.query<{ id: string }>(
              `SELECT id FROM konektag.financial_transactions
               WHERE idempotency_key = $1 AND status = 'completed'`,
              [`api-payment-order-accounting:${finalOrder.id}`],
            );
            financialTransactionId = financialTransactions[0]?.id;
          }
          if (financialTransactionId) {
            await activationChallengeService.recordActivity({
              userId: activationUsers[0].id,
              financialTransactionId,
              sourceType: 'merchant_payment',
              sourceId: finalOrder.id,
              metricType: 'MerchantPayment',
              amount: Number(finalOrder.total_amount),
              currency: finalOrder.currency,
              countryCode: activationUsers[0].country,
              metadata: { merchantProfileId: finalOrder.merchant_profile_id, paymentMethod },
            }).catch(error => console.error(`[activation] API payment projection failed for ${finalOrder.id}:`, error.message));
          }
        }
      }
      if (transitioned) {
        await publishPaymentStatus(finalOrder);
        if (deliveryId) await apiPaymentWebhookService.deliverPaymentSucceeded(deliveryId)
          .catch(error => console.error('[api-payment-webhook] Immediate delivery failed', error));
      }
      return toPublicOrder(finalOrder);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
};
