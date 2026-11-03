import { describe, expect, it, vi } from 'vitest';
import { reconcileUserGl, runDailyReconciliation } from '../../src/application/services/daily-reconciliation-service';
import type { ReconciliationResult } from '../../src/application/services/reconciliation-service';

const context = { franceLegalEntityId: 'fr', congoLegalEntityId: 'cg', currency: 'EUR' };
const matched = (gl: string): ReconciliationResult => ({ gl, rail: 'rail', expectedBalance: 0, actualBalance: 0, difference: 0, status: 'MATCHED' });

function reconciliation(results: Partial<Record<string, ReconciliationResult | undefined>> = {}, save = vi.fn().mockResolvedValue(undefined)) {
  const resultFor = (name: string, fallback: ReconciliationResult) => Object.prototype.hasOwnProperty.call(results, name) ? results[name] : fallback;
  return {
    reconcileAcquisition: vi.fn().mockResolvedValue(resultFor('acquisition', matched('acquisition'))),
    reconcileMerchantDebt: vi.fn().mockResolvedValue(resultFor('merchant', matched('merchant'))),
    reconcileSettlementBank: vi.fn().mockResolvedValue(resultFor('bank', matched('bank'))),
    reconcileIntercompany: vi.fn().mockResolvedValue(resultFor('intercompany', matched('intercompany'))),
    reconcileClearingSnapshots: vi.fn().mockResolvedValue(resultFor('clearing', matched('clearing'))),
    saveReconciliation: save,
  };
}

describe('daily P16 reconciliation gate', () => {
  it('awaits and persists each of the six mandatory matched controls exactly once', async () => {
    const service = reconciliation();
    const userGl = vi.fn().mockResolvedValue(matched('user'));
    const results = await runDailyReconciliation({} as any, service as any, '2026-01-01', context, userGl);

    expect(results).toHaveLength(6);
    expect(service.reconcileAcquisition).toHaveBeenCalledTimes(1);
    expect(userGl).toHaveBeenCalledTimes(1);
    expect(service.reconcileMerchantDebt).toHaveBeenCalledTimes(1);
    expect(service.reconcileSettlementBank).toHaveBeenCalledTimes(1);
    expect(service.reconcileIntercompany).toHaveBeenCalledTimes(1);
    expect(service.reconcileClearingSnapshots).toHaveBeenCalledTimes(1);
    expect(service.saveReconciliation).toHaveBeenCalledTimes(6);
  });

  it('rejects pending, unsupported, missing, and mismatched mandatory results before persistence', async () => {
    for (const result of [
      { ...matched('acquisition'), status: 'PENDING' },
      { ...matched('acquisition'), status: 'EXCEPTION' },
      undefined,
      { ...matched('acquisition'), status: 'MISMATCH' },
    ]) {
      const service = reconciliation({ acquisition: result as any });
      await expect(runDailyReconciliation({} as any, service as any, '2026-01-01', context, async () => matched('user'))).rejects.toThrow();
      expect(service.saveReconciliation).not.toHaveBeenCalled();
    }
  });

  it('fails when acquisition or intercompany is absent and when any control rejects', async () => {
    for (const results of [{ acquisition: undefined }, { intercompany: undefined }]) {
      const service = reconciliation(results);
      await expect(runDailyReconciliation({} as any, service as any, '2026-01-01', context, async () => matched('user'))).rejects.toThrow('RECONCILIATION_RESULT_MISSING');
    }
    const service = reconciliation();
    service.reconcileMerchantDebt.mockRejectedValueOnce(Object.assign(new Error('missing relation'), { code: '42P01' }));
    await expect(runDailyReconciliation({} as any, service as any, '2026-01-01', context, async () => matched('user'))).rejects.toThrow('missing relation');
    expect(service.saveReconciliation).not.toHaveBeenCalled();
  });

  it('fails the run when persistence fails', async () => {
    const service = reconciliation({}, vi.fn().mockRejectedValue(new Error('write failed')));
    await expect(runDailyReconciliation({} as any, service as any, '2026-01-01', context, async () => matched('user'))).rejects.toThrow('write failed');
  });
});

describe('User GL evidence', () => {
  it('maps evaluated zero with source evidence to MATCHED and applies the authoritative scope', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ source_entry_count: '2', balance: '0' }] }) };
    const result = await reconcileUserGl(client as any, '2026-01-01');
    expect(result.status).toBe('MATCHED');
    expect(result.evidence).toMatchObject({ sourceEntryCount: 2, glScope: 'GLOBAL_USER_GL' });
    expect(client.query.mock.calls[0][0]).toContain('le.gl_scope = $2');
    expect(client.query.mock.calls[0][0]).not.toContain('le.legal_entity_id');
    expect(client.query.mock.calls[0][1]).toEqual(['2026-01-01', 'GLOBAL_USER_GL']);
  });

  it('maps evaluated non-zero to MISMATCH and fails closed without source evidence or query errors', async () => {
    const mismatch = await reconcileUserGl({ query: vi.fn().mockResolvedValue({ rows: [{ source_entry_count: '1', balance: '5' }] }) } as any, '2026-01-01');
    expect(mismatch.status).toBe('MISMATCH');
    await expect(reconcileUserGl({ query: vi.fn().mockResolvedValue({ rows: [{ source_entry_count: '0', balance: '0' }] }) } as any, '2026-01-01')).rejects.toThrow('RECONCILIATION_EVIDENCE_MISSING');
    await expect(reconcileUserGl({ query: vi.fn().mockRejectedValue(Object.assign(new Error('relation missing'), { code: '42P01' })) } as any, '2026-01-01')).rejects.toThrow('relation missing');
  });
});
