import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), claim: vi.fn(), pay: vi.fn(), release: vi.fn(), claimSource: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query,
  connect: async () => ({ query: mocks.query, release: () => undefined }) } }));
vi.mock('../../src/application/link-pay/restaurant-source.ts', async original => ({
  ...await original<any>(), releaseRestaurantSource: mocks.release, claimRestaurantSource: mocks.claimSource,
}));
vi.mock('../../src/application/link-pay/frappe-site-routing.ts', async original => ({
  ...await original<any>(), beneficiaryTerms: async () => ({}),
}));
vi.mock('../../src/application/services/user-kyc-gate-service.ts', () => ({ checkUserKycVerified: async () => ({ verified: true }) }));
vi.mock('../../src/application/services/principal-idempotency-service.ts', () => ({ beginPrincipalAttempt: async () => ({ id: 'attempt' }), completePrincipalAttempt: vi.fn() }));
vi.mock('../../src/application/services/payment-link-service.ts', () => ({ paymentLinkService: { claim: mocks.claim } }));
import { networkLinkService } from '../../src/application/link-pay/network-link-service.ts';
import { payNetworkLink } from '../../src/application/link-pay/network-payment.ts';
import { LinkPaySiteError } from '../../src/application/link-pay/frappe-site-routing.ts';
const source = { attempt: '11111111-1111-4111-8111-111111111111', posProfile: 'Restaurant', fingerprint: 'a'.repeat(64) };
beforeEach(() => vi.resetAllMocks());
it('refuses cancellation of a consumed link without releasing the native cash lock', async () => {
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FOR UPDATE OF ci') ? [{
    status: 'CONSUMED', collection_source: source, public_id: 'link1', checkout_intent_id: 'checkout1',
  }] : [] }));
  await expect(networkLinkService.revokeSource('RESTODEMO', source.attempt, source.posProfile))
    .rejects.toMatchObject({ code: 'LINK_NOT_REVOCABLE', status: 409 });
  expect(mocks.release).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
});
it('revokes an abandoned link before releasing the native attempt and commits only after acknowledgement', async () => {
  const steps: string[] = [];
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('UPDATE')) steps.push('revoke');
    if (sql === 'COMMIT') steps.push('commit');
    return { rows: sql.includes('FOR UPDATE OF ci') ? [{ status: 'ISSUED', collection_source: source,
      public_id: 'link1', checkout_intent_id: 'checkout1' }] : [] };
  });
  mocks.release.mockImplementation(async () => { steps.push('release-native'); return { state: 'Cancelled' }; });
  expect(await networkLinkService.revokeSource('RESTODEMO', source.attempt, source.posProfile)).toEqual({ revoked: true });
  expect(steps).toEqual(['revoke', 'release-native', 'commit']);
});

it('rolls back the checkout and never debits when the native source changed before claim', async () => {
  mocks.query.mockResolvedValue({ rows: [] }); mocks.claim.mockResolvedValue(true);
  mocks.claimSource.mockRejectedValue(new LinkPaySiteError('SOURCE_NOT_COLLECTABLE', 409));
  const debit = vi.spyOn(networkLinkService, 'pay');
  const valuation = { sourceCurrency: 'XAF', sourceAmountMinor: 1200, rate: '1', eurAmountMinor: 1200,
    quantityK: 1200, matrixVersion: 1, validFrom: '2026-11-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z',
    authorityId: '11111111-1111-4111-8111-111111111111', approvalSource: 'approved', proofHash: 'a'.repeat(64) };
  const response = await payNetworkLink({ link: { status: 'Active', valuation, amount: 1200, quantityK: 1200,
    currency: 'XAF', source, origin: { site: 'RESTODEMO' }, network: { site: 'CONGO' }, beneficiary: { site: 'RESTODEMO' },
    reference: 'ORD-1', checkoutIntentId: 'checkout1' } as any, slug: 'link1', user: { id: 'payer' },
    attemptKey: 'a'.repeat(64), commandHash: 'b'.repeat(64), payerIdentity: null, externalTransactionId: null });
  expect(response.status).toBe(409); expect(debit).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  debit.mockRestore();
});
