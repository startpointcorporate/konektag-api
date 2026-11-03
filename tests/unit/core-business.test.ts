import { describe, expect, it } from 'vitest';
import { nextTransactionState } from '../../src/domain/core-business.ts';
import { assertMoney, convertMinor, minorDigits } from '../../src/application/services/pay/money-unit.ts';
import { assertOfflineVersion } from '../../src/domain/core-offline.ts';

describe('CORE-01 business contracts', () => {
  it.each(['ORDER', 'RESERVATION', 'REQUEST'] as const)('%s uses the generic cycle', kind => {
    expect(nextTransactionState(kind, 'CREATED', 'CONFIRM')).toBe('CONFIRMED');
    expect(nextTransactionState(kind, 'CONFIRMED', 'START')).toBe('IN_PROGRESS');
    expect(nextTransactionState(kind, 'IN_PROGRESS', 'COMPLETE')).toBe('COMPLETED');
    expect(nextTransactionState(kind, 'COMPLETED', 'CLOSE')).toBe('CLOSED');
    expect(() => nextTransactionState(kind, 'CLOSED', 'CANCEL')).toThrow('INVALID_TRANSITION');
  });
  it('configures allocation for reservable kinds only', () => {
    expect(nextTransactionState('RESERVATION', 'CONFIRMED', 'ALLOCATE')).toBe('ALLOCATED');
    expect(() => nextTransactionState('REQUEST', 'CONFIRMED', 'ALLOCATE')).toThrow('INVALID_TRANSITION');
  });
  it('keeps checkout states outside the business cycle', () => {
    expect(() => nextTransactionState('ORDER', 'CREATED', 'paid' as never)).toThrow();
  });
  it('uses PRO-01 minor units for EUR and zero-decimal XOF', () => {
    expect(minorDigits('EUR')).toBe(2);
    expect(minorDigits('XOF')).toBe(0);
    expect(convertMinor(12345, 'EUR', 'XOF', '1')).toBe(123);
    expect(() => assertMoney({ amountMinor: 1.5, currency: 'EUR' })).toThrow();
  });
  it('rejects unsupported offline contract versions', () => {
    expect(() => assertOfflineVersion({ version: 2 as never })).toThrow('UNSUPPORTED_OFFLINE_CONTRACT_VERSION');
  });
});
