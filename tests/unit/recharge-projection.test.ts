import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));
vi.mock('../../src/infrastructure/correlation-id.ts', () => ({
  getCorrelationId: () => 'corr-test',
}));

let rechargeProjection: any;

beforeEach(async () => {
  vi.resetAllMocks();
  const mod = await import('../../src/application/projection/recharge-projection.ts');
  rechargeProjection = mod.rechargeProjection;
});

function mockReadModel(overrides = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    recharge_status: 'pending',
    provider_status_detail: null,
    ledger_status: 'not_posted',
    projection_version: 1,
    last_event_id: null,
    projected_at: null,
    keycloak_id: 'kc-1',
    requested_amount: 5000,
    requested_currency: 'XOF',
    payment_method: 'card',
    payment_provider: null,
    credited_amount: null,
    credited_currency: null,
    ...overrides,
  };
}

describe('RechargeProjection — Corrected', () => {
  describe('RechargeCreated', () => {
    it('creates read model with mandatory fields', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-1', projection_version: 1 }] })
        .mockResolvedValueOnce({ rows: [] });

      await rechargeProjection.projectEvent('RechargeCreated', {
        rechargeName: 'KTG-RECH-001',
        keycloakId: 'kc-1',
        requestedAmount: 5000,
        requestedCurrency: 'XOF',
        paymentMethod: 'mobile_money',
        paymentProvider: 'MTN',
        correlationId: 'corr-1',
      });

      const insertCall = mockPool.query.mock.calls[0];
      expect(insertCall[0]).toContain('INSERT INTO konektag.recharge_projection');
      expect(insertCall[1]).toContain('KTG-RECH-001');
    });

    it('throws on missing mandatory fields', async () => {
      await expect(rechargeProjection.projectEvent('RechargeCreated', {
        rechargeName: 'KTG-RECH-001',
        correlationId: 'corr-1',
        // missing keycloakId, requestedAmount, etc.
      })).rejects.toThrow('missing mandatory fields');
    });

    it('skips idempotently if already exists with version > 0', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }); // ON CONFLICT DO UPDATE ... WHERE version = 0 → no match

      await rechargeProjection.projectEvent('RechargeCreated', {
        rechargeName: 'KTG-RECH-001',
        keycloakId: 'kc-1',
        requestedAmount: 5000,
        requestedCurrency: 'XOF',
        paymentMethod: 'card',
        correlationId: 'corr-1',
      });

      // Should not create duplicate recharge_events entry
      const eventCalls = mockPool.query.mock.calls.filter((c: any) => c[0].includes('recharge_events'));
      expect(eventCalls.length).toBe(0);
    });
  });

  describe('RechargeConfirmed — no placeholders', () => {
    it('blocks if RechargeCreated never arrived', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // SELECT — not found
        .mockResolvedValueOnce({ rows: [] }); // UPDATE block

      await rechargeProjection.projectEvent('RechargeConfirmed', {
        rechargeName: 'KTG-RECH-MISSING',
        creditedAmount: 5000,
        creditedCurrency: 'XOF',
        correlationId: 'corr-1',
      }, 'event-uuid-blocked');

      // Should have blocked, not created
      const updateCall = mockPool.query.mock.calls[1];
      expect(updateCall[0]).toContain('blocked_reason');
      expect(updateCall[1]).toContain('event-uuid-blocked');
    });

    it('blocks if ledger entry is missing', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [mockReadModel()] }) // SELECT existing
        // ledger check returns empty
        .mockResolvedValueOnce({ rows: [] })
        // block
        .mockResolvedValueOnce({ rows: [] });

      await rechargeProjection.projectEvent('RechargeConfirmed', {
        rechargeName: 'KTG-RECH-001',
        creditedAmount: 5000,
        creditedCurrency: 'XOF',
        ledgerDocumentRef: 'KTG-RECH-001',
        correlationId: 'corr-1',
      }, 'event-uuid-ledger-missing');

      const blockCall = mockPool.query.mock.calls[2];
      expect(blockCall[0]).toContain('blocked_reason');
      expect(blockCall[1]).toContain('event-uuid-ledger-missing');
    });

    it('succeeds with valid ledger entry', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [mockReadModel()] })  // SELECT existing
        .mockResolvedValueOnce({ rows: [{ amount: 5000, currency: 'XOF' }] }) // ledger check
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [] }); // INSERT recharge_events

      await rechargeProjection.projectEvent('RechargeConfirmed', {
        rechargeName: 'KTG-RECH-001',
        creditedAmount: 5000,
        creditedCurrency: 'XOF',
        ledgerDocumentRef: 'KTG-RECH-001',
        providerReference: 'pi_123',
        providerStatus: 'succeeded',
        correlationId: 'corr-1',
      }, 'event-uuid-ok');

      const updateCall = mockPool.query.mock.calls[2];
      expect(updateCall[0]).toContain("recharge_status = 'confirmed'");
      expect(updateCall[1]).toContain(5000);
    });

    it('accepts confirmed without ledgerDocumentRef if creditedAmount provided directly', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [mockReadModel()] })
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [] }); // INSERT recharge_events

      await rechargeProjection.projectEvent('RechargeConfirmed', {
        rechargeName: 'KTG-RECH-001',
        creditedAmount: 5000,
        creditedCurrency: 'XOF',
        correlationId: 'corr-1',
      }, 'event-uuid-direct');

      const updateCall = mockPool.query.mock.calls[1];
      expect(updateCall[1]).toContain(5000);
    });

    it('is idempotent on already confirmed recharge', async () => {
      const existingConfirmed = mockReadModel({ recharge_status: 'confirmed' });
      mockPool.query
        .mockResolvedValueOnce({ rows: [existingConfirmed] });
      // No UPDATE should happen

      await rechargeProjection.projectEvent('RechargeConfirmed', {
        rechargeName: 'KTG-RECH-001',
        creditedAmount: 5000,
        creditedCurrency: 'XOF',
        correlationId: 'corr-1',
      }, 'event-uuid-replay');

      // SELECT call + possible checksum import side effect
      // No UPDATE or blockEvent should occur
      const updates = mockPool.query.mock.calls.filter((c: any) =>
        String(c[0]).includes('UPDATE')
      );
      expect(updates.length).toBe(0);
    });
  });

  describe('Out-of-sequence events', () => {
    it('blocks RechargeReversed if recharge does not exist', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [] }) // SELECT — not found
        .mockResolvedValueOnce({ rows: [] }); // UPDATE block

      await rechargeProjection.projectEvent('RechargeReversed', {
        rechargeName: 'KTG-RECH-NEVER-CREATED',
        reason: 'Test',
        correlationId: 'corr-1',
      }, 'event-uuid-reverse-before-create');

      const blockCall = mockPool.query.mock.calls[1];
      expect(blockCall[0]).toContain('blocked_reason');
      expect(blockCall[1]).toContain('blocked_missing_predecessor');
    });

    it('blocks invalid transition', async () => {
      const existingFailed = mockReadModel({ workflow_state: 'failed' });
      mockPool.query
        .mockResolvedValueOnce({ rows: [existingFailed] })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE block

      await rechargeProjection.projectEvent('RechargeReversed', {
        rechargeName: 'KTG-RECH-001',
        reason: 'Test',
        correlationId: 'corr-1',
      }, 'event-uuid-invalid-tx');

      const blockCall = mockPool.query.mock.calls[1];
      expect(blockCall[0]).toContain('blocked_reason');
      expect(blockCall[1]).toContain('blocked_invalid_transition');
    });
  });

  describe('Ledger verification', () => {
    it('credits amount only when ledger entry is verified', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [mockReadModel()] })  // SELECT
        .mockResolvedValueOnce({ rows: [{ amount: 10000, currency: 'XOF' }] }) // ledger found
        .mockResolvedValueOnce({ rows: [] }) // UPDATE
        .mockResolvedValueOnce({ rows: [] }); // INSERT recharge_events

      await rechargeProjection.projectEvent('RechargeConfirmed', {
        rechargeName: 'KTG-RECH-001',
        creditedAmount: 5000,
        creditedCurrency: 'XOF',
        ledgerDocumentRef: 'KTG-RECH-001',
        correlationId: 'corr-1',
      });

      // credited_amount should come from ledger (10000), not from event payload (5000)
      const updateCall = mockPool.query.mock.calls[2];
      const ledgerAmountIdx = updateCall[1].indexOf(10000);
      expect(ledgerAmountIdx).toBeGreaterThan(-1);
    });
  });

  describe('getProjectionStatus', () => {
    it('returns null for non-existent', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const status = await rechargeProjection.getProjectionStatus('NONEXISTENT');
      expect(status).toBeNull();
    });

    it('returns metadata for existing projection', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{
          id: 'uuid-1', recharge_status: 'confirmed',
          projection_version: 3, last_event_id: 'evt-5',
          projected_at: '2026-07-19T12:00:00Z',
        }],
      });
      const status = await rechargeProjection.getProjectionStatus('KTG-RECH-001');
      expect(status!.rechargeStatus).toBe('confirmed');
      expect(status!.projectionVersion).toBe(3);
    });
  });
});
