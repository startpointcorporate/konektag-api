import { describe, it, expect } from 'vitest';
import { OnboardingStateMachine } from '../../src/domain/OnboardingStateMachine.ts';
import { InvalidTransitionError } from '../../src/domain/DomainErrors.ts';

const sm = new OnboardingStateMachine();

const ALL_STATES = [
  'DRAFT', 'ACCOUNT_CREATED', 'OTP_VERIFIED',
  'KYC_PENDING', 'KYC_PROCESSING', 'KYC_PENDING_REVIEW', 'KYC_VALIDATED',
  'KYC_REJECTED', 'KYC_SKIPPED',
  'FEATURES_SELECTED', 'COMPLETED',
] as const;

describe('OnboardingStateMachine', () => {
  describe('valid transitions', () => {
    it('DRAFT → ACCOUNT_CREATED', () => {
      expect(() => sm.assertTransition('DRAFT', 'ACCOUNT_CREATED')).not.toThrow();
    });

    it('ACCOUNT_CREATED → OTP_VERIFIED', () => {
      expect(() => sm.assertTransition('ACCOUNT_CREATED', 'OTP_VERIFIED')).not.toThrow();
    });

    it('OTP_VERIFIED → KYC_PENDING', () => {
      expect(() => sm.assertTransition('OTP_VERIFIED', 'KYC_PENDING')).not.toThrow();
    });

    it('OTP_VERIFIED → KYC_SKIPPED (skip)', () => {
      expect(() => sm.assertTransition('OTP_VERIFIED', 'KYC_SKIPPED')).not.toThrow();
    });

    it('KYC_PENDING → KYC_PROCESSING', () => {
      expect(() => sm.assertTransition('KYC_PENDING', 'KYC_PROCESSING')).not.toThrow();
    });

    it('KYC_PROCESSING → KYC_PENDING_REVIEW (OCR passed, awaiting admin)', () => {
      expect(() => sm.assertTransition('KYC_PROCESSING', 'KYC_PENDING_REVIEW')).not.toThrow();
    });

    it('KYC_PROCESSING → KYC_REJECTED', () => {
      expect(() => sm.assertTransition('KYC_PROCESSING', 'KYC_REJECTED')).not.toThrow();
    });

    it('KYC_PENDING_REVIEW → KYC_VALIDATED (admin approved)', () => {
      expect(() => sm.assertTransition('KYC_PENDING_REVIEW', 'KYC_VALIDATED')).not.toThrow();
    });

    it('KYC_PENDING_REVIEW → KYC_REJECTED (admin rejected)', () => {
      expect(() => sm.assertTransition('KYC_PENDING_REVIEW', 'KYC_REJECTED')).not.toThrow();
    });

    it('KYC_REJECTED → KYC_PENDING (resubmit)', () => {
      expect(() => sm.assertTransition('KYC_REJECTED', 'KYC_PENDING')).not.toThrow();
    });

    it('KYC_VALIDATED → FEATURES_SELECTED', () => {
      expect(() => sm.assertTransition('KYC_VALIDATED', 'FEATURES_SELECTED')).not.toThrow();
    });

    it('KYC_SKIPPED → KYC_PENDING', () => {
      expect(() => sm.assertTransition('KYC_SKIPPED', 'KYC_PENDING')).not.toThrow();
    });
    it('KYC_SKIPPED → FEATURES_SELECTED (complete onboarding after deferring KYC)', () => {
      expect(() => sm.assertTransition('KYC_SKIPPED', 'FEATURES_SELECTED')).not.toThrow();
    });

    it('KYC_SKIPPED → KYC_PENDING (start KYC later)', () => {
      expect(() => sm.assertTransition('KYC_SKIPPED', 'KYC_PENDING')).not.toThrow();
    });

    it('FEATURES_SELECTED → COMPLETED', () => {
      expect(() => sm.assertTransition('FEATURES_SELECTED', 'COMPLETED')).not.toThrow();
    });

    it('allows the deferred-KYC onboarding sequence without skipping preferences', () => {
      expect(() => sm.assertTransition('OTP_VERIFIED', 'KYC_SKIPPED')).not.toThrow();
      expect(() => sm.assertTransition('KYC_SKIPPED', 'FEATURES_SELECTED')).not.toThrow();
      expect(() => sm.assertTransition('FEATURES_SELECTED', 'COMPLETED')).not.toThrow();
      expect(() => sm.assertTransition('KYC_SKIPPED', 'COMPLETED')).toThrow(InvalidTransitionError);
    });

    it('COMPLETED → KYC_PENDING (resubmit KYC)', () => {
      expect(() => sm.assertTransition('COMPLETED', 'KYC_PENDING')).not.toThrow();
    });
  });

  describe('invalid transitions', () => {
    it('rejects DRAFT → KYC_SKIPPED (step jump)', () => {
      expect(() => sm.assertTransition('DRAFT', 'KYC_SKIPPED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects DRAFT → COMPLETED (huge jump)', () => {
      expect(() => sm.assertTransition('DRAFT', 'COMPLETED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects OTP_VERIFIED → COMPLETED', () => {
      expect(() => sm.assertTransition('OTP_VERIFIED', 'COMPLETED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects KYC_PENDING → FEATURES_SELECTED (skip processing)', () => {
      expect(() => sm.assertTransition('KYC_PENDING', 'FEATURES_SELECTED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects KYC_PROCESSING → FEATURES_SELECTED', () => {
      expect(() => sm.assertTransition('KYC_PROCESSING', 'FEATURES_SELECTED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects KYC_PENDING_REVIEW → FEATURES_SELECTED', () => {
      expect(() => sm.assertTransition('KYC_PENDING_REVIEW', 'FEATURES_SELECTED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects KYC_REJECTED → COMPLETED', () => {
      expect(() => sm.assertTransition('KYC_REJECTED', 'COMPLETED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects COMPLETED → DRAFT (backwards terminal)', () => {
      expect(() => sm.assertTransition('COMPLETED', 'DRAFT'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects going backwards (KYC_VALIDATED → OTP_VERIFIED)', () => {
      expect(() => sm.assertTransition('KYC_VALIDATED', 'OTP_VERIFIED'))
        .toThrow(InvalidTransitionError);
    });

    it('rejects ACCOUNT_CREATED → DRAFT', () => {
      expect(() => sm.assertTransition('ACCOUNT_CREATED', 'DRAFT'))
        .toThrow(InvalidTransitionError);
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transitions', () => {
      expect(sm.canTransition('DRAFT', 'ACCOUNT_CREATED')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(sm.canTransition('DRAFT', 'COMPLETED')).toBe(false);
    });
  });

  describe('projectKycStatus', () => {
    it('returns "none" for DRAFT', () => {
      expect(OnboardingStateMachine.projectKycStatus('DRAFT')).toBe('none');
    });

    it('returns "pending" for KYC_PENDING', () => {
      expect(OnboardingStateMachine.projectKycStatus('KYC_PENDING')).toBe('pending');
    });

    it('returns "processing" for KYC_PROCESSING', () => {
      expect(OnboardingStateMachine.projectKycStatus('KYC_PROCESSING')).toBe('processing');
    });

    it('returns "verified" for KYC_VALIDATED', () => {
      expect(OnboardingStateMachine.projectKycStatus('KYC_VALIDATED')).toBe('verified');
    });

    it('returns "rejected" for KYC_REJECTED', () => {
      expect(OnboardingStateMachine.projectKycStatus('KYC_REJECTED')).toBe('rejected');
    });

    it('returns "skipped" for KYC_SKIPPED', () => {
      expect(OnboardingStateMachine.projectKycStatus('KYC_SKIPPED')).toBe('skipped');
    });

    it('returns "pending_review" for KYC_PENDING_REVIEW', () => {
      expect(OnboardingStateMachine.projectKycStatus('KYC_PENDING_REVIEW')).toBe('pending_review');
    });

    it('returns "none" for ACCOUNT_CREATED', () => {
      expect(OnboardingStateMachine.projectKycStatus('ACCOUNT_CREATED')).toBe('none');
    });
  });

  describe('projectStep', () => {
    it('returns 2 for DRAFT', () => {
      expect(OnboardingStateMachine.projectStep('DRAFT')).toBe(2);
    });

    it('returns 3 for ACCOUNT_CREATED', () => {
      expect(OnboardingStateMachine.projectStep('ACCOUNT_CREATED')).toBe(3);
    });

    it('returns 4 for OTP_VERIFIED', () => {
      expect(OnboardingStateMachine.projectStep('OTP_VERIFIED')).toBe(4);
    });

    it('returns 4 for KYC_PENDING', () => {
      expect(OnboardingStateMachine.projectStep('KYC_PENDING')).toBe(4);
    });

    it('returns 4 for KYC_PENDING_REVIEW', () => {
      expect(OnboardingStateMachine.projectStep('KYC_PENDING_REVIEW')).toBe(4);
    });

    it('returns 5 for KYC_VALIDATED', () => {
      expect(OnboardingStateMachine.projectStep('KYC_VALIDATED')).toBe(5);
    });

    it('returns null for COMPLETED', () => {
      expect(OnboardingStateMachine.projectStep('COMPLETED')).toBeNull();
    });
  });
});
