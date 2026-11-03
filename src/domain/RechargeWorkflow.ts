import type { RechargeStatus, ProviderStatusDetail, LedgerStatus } from './RechargeProjection.ts';

/**
 * Transition rules for the three orthogonal recharge status dimensions.
 * Each dimension is governed by its own source of authority:
 *
 * recharge_status:
 *   Source: domain workflow (RechargeCreated, RechargeConfirmed, RechargeFailed, RechargeReversed)
 *   Meaning: lifecycle of the recharge request itself
 *
 * provider_status_detail:
 *   Source: external payment provider status (Stripe webhook, MM callback, crypto tx)
 *   Meaning: what the external payment system reports
 *
 * ledger_status:
 *   Source: konektag.ledger_entries
 *   Meaning: accounting impact (credit/debit/reversal posted)
 */
export const RECHARGE_STATUS_TRANSITIONS: Record<RechargeStatus, RechargeStatus[]> = {
  pending:   ['confirmed', 'failed'],
  confirmed: ['reversed'],
  failed:    ['pending'],
  reversed:  [],
};

export const PROVIDER_STATUS_TRANSITIONS: Record<ProviderStatusDetail, ProviderStatusDetail[]> = {
  not_submitted:     ['submitted', 'unknown'],
  submitted:         ['accepted', 'rejected', 'unknown'],
  accepted:          ['pending_settlement', 'completed', 'rejected'],
  pending_settlement: ['completed', 'rejected'],
  completed:         [],
  rejected:          [],
  unknown:           ['submitted', 'accepted', 'completed', 'rejected'],
};

export const LEDGER_STATUS_TRANSITIONS: Record<LedgerStatus, LedgerStatus[]> = {
  not_posted:   ['posted'],
  posted:       ['reversed'],
  reversed:     [],
  inconsistent: ['posted', 'not_posted'],
};

export function assertValidRechargeTransition(from: RechargeStatus, to: RechargeStatus): void {
  const allowed = RECHARGE_STATUS_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`Invalid recharge_status transition: ${from} → ${to}`);
  }
}

export function assertValidProviderTransition(from: ProviderStatusDetail, to: ProviderStatusDetail): void {
  const allowed = PROVIDER_STATUS_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`Invalid provider_status_detail transition: ${from} → ${to}`);
  }
}

export function assertValidLedgerTransition(from: LedgerStatus, to: LedgerStatus): void {
  const allowed = LEDGER_STATUS_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`Invalid ledger_status transition: ${from} → ${to}`);
  }
}

export function isTerminalRechargeStatus(s: RechargeStatus): boolean {
  return s === 'reversed';
}

export function isActiveRechargeStatus(s: RechargeStatus): boolean {
  return s === 'pending' || s === 'confirmed';
}
