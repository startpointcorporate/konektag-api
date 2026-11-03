import type { Money } from '../application/services/pay/money-unit.ts';

export type { Money } from '../application/services/pay/money-unit.ts';
export type TransactionKind = 'ORDER' | 'RESERVATION' | 'REQUEST';
export type TransactionState = 'CREATED' | 'CONFIRMED' | 'ALLOCATED' | 'IN_PROGRESS' |
  'COMPLETED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED' | 'DISPUTED';
export type TransitionCommand = 'CONFIRM' | 'ALLOCATE' | 'START' | 'COMPLETE' |
  'CLOSE' | 'CANCEL' | 'EXPIRE' | 'REJECT' | 'DISPUTE';
export const CORE_CONTRACT_VERSION = 1 as const;

export interface PricingContext { marketCountry: string; sellerLegalEntityCode: string; pricingVersion: number }
/** merchant_products.id is the Offer identity. */
export interface Offer { id: string; merchantProfileId: string; name: string; description?: string; active: boolean }
/** product_pricing_rules.id identifies a merchant-owned Konektag price variant. Payment legal-entity resolution is separate. */
export interface OfferVariant { id: string; offerId: string; merchantProfileId: string; price: Money; context: PricingContext }
export interface Resource { id: string; merchantProfileId: string; kind: 'PERSON' | 'PLACE' | 'EQUIPMENT' | 'STOCK' | 'OTHER'; label: string }
export interface Capacity { id: string; merchantProfileId: string; resourceId: string; units: number; unitCode: string }
export interface Availability { id: string; merchantProfileId: string; capacityId: string; startsAt: string; endsAt: string; availableUnits: number }
export interface TransactionLine { id: string; transactionId: string; offerId?: string; pricingRuleId?: string; label: string; quantity: number; unitPrice: Money }
export interface Transaction { id: string; merchantProfileId: string; customerUserId: string | null; kind: TransactionKind; state: TransactionState; stateVersion: number; contractVersion: 1; total: Money; paymentOrderId?: string; lines: TransactionLine[] }
export interface Allocation { id: string; transactionLineId: string; availabilityId: string; units: number; state: 'ACTIVE' | 'RELEASED' }
export interface TransitionJournal { transactionId: string; actorUserId: string; commandKey: string; fromState: TransactionState; toState: TransactionState; fromVersion: number; toVersion: number }

const common: Record<TransitionCommand, readonly TransactionState[]> = {
  CONFIRM: ['CREATED'], ALLOCATE: ['CONFIRMED'], START: ['CONFIRMED', 'ALLOCATED'],
  COMPLETE: ['IN_PROGRESS'], CLOSE: ['COMPLETED'], CANCEL: ['CREATED', 'CONFIRMED', 'ALLOCATED'],
  EXPIRE: ['CREATED', 'CONFIRMED'], REJECT: ['CREATED'], DISPUTE: ['COMPLETED', 'CLOSED'],
};
const target: Record<TransitionCommand, TransactionState> = {
  CONFIRM: 'CONFIRMED', ALLOCATE: 'ALLOCATED', START: 'IN_PROGRESS', COMPLETE: 'COMPLETED',
  CLOSE: 'CLOSED', CANCEL: 'CANCELLED', EXPIRE: 'EXPIRED', REJECT: 'REJECTED', DISPUTE: 'DISPUTED',
};
const configured: Record<TransactionKind, ReadonlySet<TransitionCommand>> = {
  ORDER: new Set(['CONFIRM', 'ALLOCATE', 'START', 'COMPLETE', 'CLOSE', 'CANCEL', 'EXPIRE', 'REJECT', 'DISPUTE']),
  RESERVATION: new Set(['CONFIRM', 'ALLOCATE', 'START', 'COMPLETE', 'CLOSE', 'CANCEL', 'EXPIRE', 'REJECT', 'DISPUTE']),
  REQUEST: new Set(['CONFIRM', 'START', 'COMPLETE', 'CLOSE', 'CANCEL', 'EXPIRE', 'REJECT', 'DISPUTE']),
};
export function nextTransactionState(kind: TransactionKind, from: TransactionState, command: TransitionCommand): TransactionState {
  if (!configured[kind].has(command) || !common[command].includes(from)) throw new Error('INVALID_TRANSITION');
  return target[command];
}

/** Enumerate the existing state machine; never duplicate its transition rules in the UI. */
export function allowedTransactionCommands(kind: TransactionKind, state: TransactionState): TransitionCommand[] {
  return [...configured[kind]].filter(command => {
    try { nextTransactionState(kind, state, command); return true; } catch { return false; }
  });
}
