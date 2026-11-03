import { describe, it, expect } from 'vitest';
import {
  DomainError,
  InvalidTransitionError,
  ConcurrencyError,
  NotFoundError,
  OnboardingError,
  RetryableError,
} from '../../src/domain/DomainErrors.ts';

describe('DomainError', () => {
  it('creates error with code and message', () => {
    const err = new DomainError('TEST_CODE', 'test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.name).toBe('DomainError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('InvalidTransitionError', () => {
  it('includes from and to states', () => {
    const err = new InvalidTransitionError('DRAFT', 'COMPLETED');
    expect(err.code).toBe('INVALID_TRANSITION');
    expect(err.message).toContain('DRAFT');
    expect(err.message).toContain('COMPLETED');
  });
});

describe('ConcurrencyError', () => {
  it('includes entity, id, version', () => {
    const err = new ConcurrencyError('User', 'abc-123', 3);
    expect(err.code).toBe('CONCURRENCY_CONFLICT');
    expect(err.message).toContain('User');
    expect(err.message).toContain('abc-123');
    expect(err.message).toContain('3');
  });
});

describe('NotFoundError', () => {
  it('includes entity and id', () => {
    const err = new NotFoundError('User', 'xyz');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('User');
    expect(err.message).toContain('xyz');
  });
});

describe('OnboardingError', () => {
  it('uses code as both code and prefix', () => {
    const err = new OnboardingError('OTP_EXPIRED');
    expect(err.code).toBe('OTP_EXPIRED');
    expect(err.message).toContain('OTP_EXPIRED');
  });
});

describe('RetryableError', () => {
  it('is not a DomainError', () => {
    const err = new RetryableError('connection timeout');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DomainError);
  });
});
