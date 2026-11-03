import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const { mockPool } = vi.hoisted(() => ({
  mockPool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));
vi.mock('qrcode', () => ({ default: { toString: vi.fn(() => '<svg>mock-qr</svg>') } }));

import { cardBatchService } from '../../src/application/services/card-batch-service.ts';

function mockCard(overrides: Partial<{
  id: string; number: string; amount: number; status: string; version: number;
  pin: string; qr_code: string; sold_by: string; sold_at: string; redeemed_at: string; redeemed_by: string;
  batch_id: string; created_at: string;
}> = {}) {
  return {
    id: overrides.id || 'card-001',
    number: overrides.number || '1000000000000001',
    amount: overrides.amount || 5000,
    status: overrides.status || 'GENERATED',
    version: overrides.version || 1,
    pin: overrides.pin || 'abc123hash',
    qr_code: overrides.qr_code || '<svg>qr</svg>',
    sold_by: overrides.sold_by || null,
    sold_at: overrides.sold_at || null,
    redeemed_at: overrides.redeemed_at || null,
    redeemed_by: overrides.redeemed_by || null,
    batch_id: overrides.batch_id || 'batch-001',
    created_at: overrides.created_at || '2026-07-01T00:00:00Z',
  };
}

function mockAgentRow() {
  return { agent_enabled: true, mp_status: 'Published', state: 'COMPLETED' };
}

function mockNoAgentRow() {
  return { agent_enabled: false, mp_status: 'Published', state: 'COMPLETED' };
}

describe('cardBatchService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isAgent', () => {
    it('returns true for merchant with agent_enabled = true', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockAgentRow()] });
      expect(await cardBatchService.isAgent('user-merchant')).toBe(true);
    });

    it('returns false for merchant with agent_enabled = false', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockNoAgentRow()] });
      expect(await cardBatchService.isAgent('user-merchant')).toBe(false);
    });

    it('returns false for merchant with null agent_enabled', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ agent_enabled: null, mp_status: 'Published', state: 'COMPLETED' }] });
      expect(await cardBatchService.isAgent('user-merchant')).toBe(false);
    });

    it('returns false for suspended merchant profile', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      expect(await cardBatchService.isAgent('user-merchant')).toBe(false);
    });

    it('returns false for Draft profile', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      expect(await cardBatchService.isAgent('user-merchant')).toBe(false);
    });

    it('returns false for personal user without merchant profile', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      expect(await cardBatchService.isAgent('user-personal')).toBe(false);
    });

    it('returns false for BANNED user', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ agent_enabled: true, mp_status: 'Published', state: 'BANNED' }] });
      expect(await cardBatchService.isAgent('user-banned')).toBe(false);
    });

    it('returns false when merchant membership not active', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      expect(await cardBatchService.isAgent('user-no-membership')).toBe(false);
    });
  });

  describe('sellCardByScan', () => {
    it('rejects non-agent user', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await cardBatchService.sellCardByScan('1000000000000001', 'user-regular');
      expect(result.success).toBe(false);
      expect(result.message).toContain('capacité Agent');
    });

    it('rejects merchant without agent_enabled', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockNoAgentRow()] });
      const result = await cardBatchService.sellCardByScan('1000000000000001', 'user-merchant');
      expect(result.success).toBe(false);
      expect(result.message).toContain('capacité Agent');
    });

    it('rejects banned agent', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ agent_enabled: true, mp_status: 'Published', state: 'BANNED' }] });
      const result = await cardBatchService.sellCardByScan('1000000000000001', 'user-banned');
      expect(result.success).toBe(false);
    });

    it('rejects non-existent card', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockAgentRow()] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await cardBatchService.sellCardByScan('9999000000000000', 'user-agent');
      expect(result.success).toBe(false);
      expect(result.message).toContain('introuvable');
    });

    it('rejects already SOLD card', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockAgentRow()] });
      mockPool.query.mockResolvedValueOnce({ rows: [mockCard({ status: 'SOLD' })] });
      const result = await cardBatchService.sellCardByScan('1000000000000001', 'user-agent');
      expect(result.success).toBe(false);
      expect(result.message).toContain('déjà été vendue');
    });

    it('rejects already ACTIVATED card', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockAgentRow()] });
      mockPool.query.mockResolvedValueOnce({ rows: [mockCard({ status: 'ACTIVATED' })] });
      const result = await cardBatchService.sellCardByScan('1000000000000001', 'user-agent');
      expect(result.success).toBe(false);
      expect(result.message).toContain('déjà été activée');
    });

    it('successfully sells a DISTRIBUTED card', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockAgentRow()] });
      mockPool.query.mockResolvedValueOnce({ rows: [mockCard({ status: 'DISTRIBUTED', version: 1 })] });
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      const result = await cardBatchService.sellCardByScan('1000000000000001', 'user-agent');
      expect(result.success).toBe(true);
    });

    it('handles concurrent sale (version conflict)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockAgentRow()] });
      mockPool.query.mockResolvedValueOnce({ rows: [mockCard({ status: 'DISTRIBUTED', version: 1 })] });
      mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
      const result = await cardBatchService.sellCardByScan('1000000000000001', 'user-agent');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Conflit');
    });
  });

  describe('redeemCard', () => {
    it('rejects GENERATED card', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockCard({ status: 'GENERATED' })] });
      const result = await cardBatchService.redeemCard('1000000000000001', '123456', 'user-1', 'kc-1', '1.2.3.4', 'ua');
      expect(result.success).toBe(false);
      expect(result.message).toContain('pas encore été validée comme vendue');
    });

    it('returns the existing activation result for an ACTIVATED card', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [mockCard({ status: 'ACTIVATED' })] });
      const result = await cardBatchService.redeemCard('1000000000000001', '123456', 'user-1', 'kc-1', '1.2.3.4', 'ua');
      expect(result.success).toBe(true);
      expect(result.amount).toBe(5000);
    });

    it('rejects non-existent card', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const result = await cardBatchService.redeemCard('9999000000000000', '123456', 'user-1', 'kc-1', '1.2.3.4', 'ua');
      expect(result.success).toBe(false);
      expect(result.message).toContain('introuvable');
    });

    it('rejects user without KYC', async () => {
      const correctHash = crypto.createHash('sha256').update('123456').digest('hex');
      mockPool.query.mockResolvedValueOnce({ rows: [mockCard({ status: 'SOLD', pin: correctHash })] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ created_at: new Date().toISOString() }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ state: 'ONBOARDING' }] });
      const result = await cardBatchService.redeemCard('1000000000000001', '123456', 'user-1', 'kc-1', '1.2.3.4', 'ua');
      expect(result.success).toBe(false);
      expect(result.message).toContain('KYC');
    });
  });

  describe('getMerchantReport', () => {
    it('returns empty report when no cards sold', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ total_sold: '0', total_value: '0' }] });
      const report = await cardBatchService.getMerchantReport();
      expect(report.report).toHaveLength(0);
      expect(report.totalSold).toBe(0);
    });

    it('returns report filtered by date range', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ merchant_id: 'agent-1', total_sold: 5, total_value: 25000, total_activated: 3, sold_not_activated: 2 }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ sold_at: '2026-07-20', card_number: '1000000000000001', amount: 5000, status: 'ACTIVATED', activated_at: '2026-07-21' }] });
      mockPool.query.mockResolvedValueOnce({ rows: [{ total_sold: '5', total_value: '25000' }] });
      const report = await cardBatchService.getMerchantReport('agent-1', '2026-07-01', '2026-07-31');
      expect(report.report).toHaveLength(1);
      expect(report.report[0].totalSold).toBe(5);
      expect(report.details).toHaveLength(1);
    });
  });

  describe('toggleAgentCapability', () => {
    it('enables agent capability', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      expect((await cardBatchService.toggleAgentCapability('mp-1', true, 'admin-1')).success).toBe(true);
    });

    it('disables agent capability', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      expect((await cardBatchService.toggleAgentCapability('mp-1', false, 'admin-1')).success).toBe(true);
    });
  });

  describe('commissionRates', () => {
    it('returns empty rates for merchant with no rates', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const rates = await cardBatchService.getCommissionRates('mp-1');
      expect(rates).toHaveLength(0);
    });

    it('returns rates for merchant', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [
        { id: 'r-1', country_code: 'CG', commission_rate: '2.5', is_active: true },
        { id: 'r-2', country_code: 'CI', commission_rate: '1.0', is_active: false },
      ]});
      const rates = await cardBatchService.getCommissionRates('mp-1');
      expect(rates).toHaveLength(2);
      expect(rates[0].country_code).toBe('CG');
    });

    it('upserts a new commission rate', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      await cardBatchService.upsertCommissionRate('mp-1', 'CG', 2.5, true);
      expect(mockPool.query).toHaveBeenCalled();
    });

    it('deletes a commission rate', async () => {
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
      await cardBatchService.deleteCommissionRate('r-1');
      expect(mockPool.query).toHaveBeenCalled();
    });
  });
});
