export type OnboardingState =
  | 'DRAFT' | 'ACCOUNT_CREATED' | 'OTP_VERIFIED'
  | 'KYC_PENDING' | 'KYC_PROCESSING' | 'KYC_PENDING_REVIEW' | 'KYC_VALIDATED'
  | 'KYC_REJECTED' | 'KYC_SKIPPED'
  | 'FEATURES_SELECTED' | 'COMPLETED';

const VALID_TRANSITIONS: Record<OnboardingState, OnboardingState[]> = {
  DRAFT:               ['ACCOUNT_CREATED'],
  ACCOUNT_CREATED:     ['OTP_VERIFIED', 'KYC_PENDING', 'KYC_SKIPPED'],
  OTP_VERIFIED:        ['KYC_PENDING', 'KYC_SKIPPED'],
  KYC_PENDING:         ['KYC_PROCESSING', 'KYC_PENDING'],
  KYC_PROCESSING:      ['KYC_PENDING_REVIEW', 'KYC_REJECTED'],
  KYC_PENDING_REVIEW:  ['KYC_VALIDATED', 'KYC_REJECTED'],
  KYC_VALIDATED:       ['FEATURES_SELECTED'],
  KYC_REJECTED:        ['KYC_PENDING'],
  KYC_SKIPPED:         ['KYC_PENDING', 'FEATURES_SELECTED'],
  FEATURES_SELECTED:   ['COMPLETED'],
  COMPLETED:           ['KYC_PENDING'],
};

import { InvalidTransitionError } from './DomainErrors.ts';

export class OnboardingStateMachine {
  assertTransition(current: OnboardingState, target: OnboardingState): void {
    const allowed = VALID_TRANSITIONS[current];
    if (!allowed?.includes(target)) {
      throw new InvalidTransitionError(current, target);
    }
  }

  canTransition(current: OnboardingState, target: OnboardingState): boolean {
    return VALID_TRANSITIONS[current]?.includes(target) ?? false;
  }

  static projectKycStatus(state: OnboardingState): string {
    switch (state) {
      case 'KYC_VALIDATED':       return 'verified';
      case 'KYC_PENDING_REVIEW':  return 'pending_review';
      case 'KYC_PROCESSING':      return 'processing';
      case 'KYC_PENDING':         return 'pending';
      case 'KYC_REJECTED':        return 'rejected';
      case 'KYC_SKIPPED':         return 'skipped';
      default:                    return 'none';
    }
  }

  static projectStep(state: OnboardingState): number | null {
    const map: Record<OnboardingState, number | null> = {
      DRAFT: 2, ACCOUNT_CREATED: 3, OTP_VERIFIED: 4,
      KYC_PENDING: 4, KYC_PROCESSING: 4, KYC_PENDING_REVIEW: 4, KYC_VALIDATED: 5,
      KYC_REJECTED: 4, KYC_SKIPPED: 5, FEATURES_SELECTED: 5,
      COMPLETED: null,
    };
    return map[state];
  }
}

export const stateMachine = new OnboardingStateMachine();
