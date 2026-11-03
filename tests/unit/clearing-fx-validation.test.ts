import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  markSettled: vi.fn(), permission: vi.fn(), query: vi.fn(), release: vi.fn(), postTransaction: vi.fn(),
}));
vi.mock('../../src/application/services/clearing-service.ts', () => ({ clearingService: { markSettled: mocks.markSettled } }));
vi.mock('../../src/application/services/backoffice-permission-service.ts', () => ({ requireBackofficePermission: () => mocks.permission, forbiddenResponse: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { connect: vi.fn(async () => ({ query: mocks.query, release: mocks.release })) } }));
vi.mock('../../src/application/services/accounting-service.ts', () => ({ accountingService: { postTransaction: mocks.postTransaction } }));
import { POST } from '../../src/api/routes/admin/clearing/settle.ts';
const { clearingService } = await vi.importActual<typeof import('../../src/application/services/clearing-service.ts')>('../../src/application/services/clearing-service.ts');

type ApprovedBatch = {
  id: string; status: string; source_currency: string; target_currency: string;
  fx_evidence_id: string | null; legal_entity_id: string; counterparty_entity_id: string;
  b2b_profile_id: string; batch_ref: string; currency: string; net_amount: string;
  gross_amount: string; version: number; profile_settlement_currency: string;
  period_start: string; period_end: string; netting_allowed: boolean;
  [key: string]: unknown;
};

const approvedBatch = (source_currency: string, target_currency: string): ApprovedBatch => ({
  id: 'batch-1', status: 'APPROVED', source_currency, target_currency, fx_evidence_id: null,
  legal_entity_id: 'entity-a', counterparty_entity_id: 'entity-b', b2b_profile_id: 'profile-1',
  batch_ref: 'CLR-1', currency: 'EUR', net_amount: '10', gross_amount: '10', version: 1,
  profile_settlement_currency: 'EUR',
  period_start: '2026-08-01', period_end: '2026-08-04', netting_allowed: true,
});

const projectionFacts = { gross_receivable: '30', gross_payable: '20', regulatory_profile_id: 'reg-profile-1', profile_count: '1', missing_profile_count: '0', corridor: 'FR-CG', corridor_count: '1', missing_corridor_count: '0' };

const authoritativeEvidence = (overrides = {}) => ({
  fx_evidence_id: 'evidence-1', fx_source_currency: 'EUR', fx_target_currency: 'XAF', fx_rate: '655.957',
  fx_evidence_ref: 'ECB-2026-07-29', fx_rate_source: 'ECB', fx_valued_at: '2026-07-29T00:00:00.000Z',
  fx_recorded_by: 'operator-1', ...overrides,
});

const mockSettlementQueries = (batch: ApprovedBatch) => {
  mocks.query.mockImplementation(async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('FROM konektag.clearing_batches cb')) return { rows: [batch] };
    if (sql.includes('SELECT country_code, base_currency FROM konektag.legal_entities')) {
      const currency = parameters?.[0] === 'entity-a' ? batch.source_currency : batch.target_currency;
      return { rows: [{ country_code: currency === 'EUR' ? 'FR' : 'CG', base_currency: currency }] };
    }
    if (sql.includes('SELECT code, country_code')) return { rows: [{ code: 'KTG-FR', country_code: 'FR' }] };
    if (sql.includes("SET status = 'SETTLED'")) return { rows: [{ ...batch, status: 'SETTLED', fx_rate: batch.fx_rate }] };
    if (sql.includes('gross_receivable')) return { rows: [projectionFacts] };
    return { rows: [] };
  });
};

describe('clearing FX validation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.postTransaction.mockResolvedValue({ success: true });
  });
  it('rejects a client supplied FX rate before clearing settlement', async () => {
    mocks.permission.mockResolvedValue({ authorized: true, user: { id: 'operator-1' } });
    const response = await POST({ locals: {}, request: new Request('http://localhost', { method: 'POST', body: JSON.stringify({ batchId: 'batch-1', bankProofUrl: 'https://bank/proof', fxRate: '1.2' }) }) } as any);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'FX_CLIENT_SUPPLIED_RATE_FORBIDDEN' });
    expect(mocks.markSettled).not.toHaveBeenCalled();
  });

  it('fails closed before posting when a cross-currency batch has no authoritative FX evidence', async () => {
    mockSettlementQueries(approvedBatch('EUR', 'XAF'));

    await expect(clearingService.markSettled({ batchId: 'batch-1', bankProofUrl: 'https://bank/proof', settledBy: 'operator-1' }))
      .rejects.toThrow('AUTHORITATIVE_FX_EVIDENCE_REQUIRED');

    expect(mocks.postTransaction).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes("status = 'SETTLED'"))).toBe(false);
  });

  it('does not require FX evidence for a same-currency batch', async () => {
    const batch = approvedBatch('EUR', 'EUR');
    mockSettlementQueries(batch);

    await expect(clearingService.markSettled({ batchId: 'batch-1', bankProofUrl: 'https://bank/proof', settledBy: 'operator-1' }))
      .resolves.toMatchObject({ status: 'SETTLED' });

    expect(mocks.postTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes("status = 'SETTLED'"))).toBe(true);
  });

  it('rejects authoritative FX evidence whose currency pair does not match the clearing entities', async () => {
    const batch = { ...approvedBatch('EUR', 'XAF'), ...authoritativeEvidence({ fx_target_currency: 'USD' }) };
    mockSettlementQueries(batch);

    await expect(clearingService.markSettled({ batchId: 'batch-1', bankProofUrl: 'https://bank/proof', settledBy: 'operator-1' }))
      .rejects.toThrow('AUTHORITATIVE_FX_EVIDENCE_INVALID');

    expect(mocks.postTransaction).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes("status = 'SETTLED'"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('SET fx_rate'))).toBe(false);
  });

  it('rejects incomplete authoritative FX evidence before posting', async () => {
    const batch = { ...approvedBatch('EUR', 'XAF'), ...authoritativeEvidence({ fx_evidence_ref: ' ' }) };
    mockSettlementQueries(batch);

    await expect(clearingService.markSettled({ batchId: 'batch-1', bankProofUrl: 'https://bank/proof', settledBy: 'operator-1' }))
      .rejects.toThrow('AUTHORITATIVE_FX_EVIDENCE_INVALID');

    expect(mocks.postTransaction).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes("status = 'SETTLED'"))).toBe(false);
  });

  it('settles a cross-currency batch using authoritative FX evidence', async () => {
    const batch = { ...approvedBatch('EUR', 'XAF'), ...authoritativeEvidence() };
    mockSettlementQueries(batch);

    await expect(clearingService.markSettled({ batchId: 'batch-1', bankProofUrl: 'https://bank/proof', settledBy: 'operator-1' }))
      .resolves.toMatchObject({ status: 'SETTLED', fx_rate: '655.957' });

    const fxRateUpdate = mocks.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('SET fx_rate'));
    expect(fxRateUpdate?.[1]).toEqual(['batch-1', 655.957]);
    expect(mocks.postTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.postTransaction.mock.calls[0][0].metadata.regulatedExecutionRef).toBe('ECB-2026-07-29');
    const settlementUpdateOrder = mocks.query.mock.invocationCallOrder[mocks.query.mock.calls.findIndex(([sql]) => typeof sql === 'string' && sql.includes("status = 'SETTLED'"))];
    expect(mocks.postTransaction.mock.invocationCallOrder[1]).toBeLessThan(settlementUpdateOrder);
  });
});
