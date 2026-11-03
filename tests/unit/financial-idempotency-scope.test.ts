import { describe, expect, it } from 'vitest';
import { financialRequestFingerprint, requiresLegalEntityScope, resolveFinancialRouteKey } from '../../src/application/services/financial-idempotency-scope.ts';

describe('financial idempotency scope', () => {
  it('defers Legal Entity scoping for merchantless wallet recharge only', () => {
    expect(requiresLegalEntityScope('/api/pay/recharges')).toBe(false);
    expect(requiresLegalEntityScope('/api/pay/payments')).toBe(true);
  });
  it('resolves registered financial operations and rejects unknown ones', () => {
    expect(resolveFinancialRouteKey('/api/transfer/confirm')).toBeNull();
    for (const path of ['/api/qr/request-confirmation', '/api/k/send/intent', '/api/pay/pay-link', '/api/pay/payment-links/slug/resume']) {
      expect(resolveFinancialRouteKey(path)).toBeNull();
      expect(requiresLegalEntityScope(path)).toBe(false);
    }
    expect(resolveFinancialRouteKey('/api/admin/clearing/approve')).toBe('CLEARING_APPROVE');
    expect(resolveFinancialRouteKey('/api/earn/withdraw')).toBeNull();
    expect(resolveFinancialRouteKey('/api/pay/payment-links')).toBeNull();
    expect(resolveFinancialRouteKey('/api/pay/payment-links/')).toBeNull();
  });

  it('hashes semantically identical JSON requests identically', () => {
    const first = financialRequestFingerprint(
      'CLEARING_APPROVE', 'USER', 'user-1', 'entity-1', '{"amount":100,"currency":"EUR"}',
    );
    const second = financialRequestFingerprint(
      'CLEARING_APPROVE', 'USER', 'user-1', 'entity-1', '{"currency":"EUR","amount":100}',
    );

    expect(first).toBe(second);
  });

  it('binds the fingerprint to actor and legal entity scope', () => {
    const baseline = financialRequestFingerprint(
      'CLEARING_APPROVE', 'USER', 'user-1', 'entity-1', '{"amount":100}',
    );

    expect(financialRequestFingerprint('CLEARING_APPROVE', 'USER', 'user-2', 'entity-1', '{"amount":100}')).not.toBe(baseline);
    expect(financialRequestFingerprint('CLEARING_APPROVE', 'USER', 'user-1', 'entity-2', '{"amount":100}')).not.toBe(baseline);
  });
});
