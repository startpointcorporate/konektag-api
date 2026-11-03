import { describe, expect, it, vi } from 'vitest';
import { ReconciliationService } from '../../src/application/services/reconciliation-service.ts';

describe('reconciliation evidence', () => {
  it('matches only deterministic totals within the explicit tolerance', async () => {
    const client: any = { query: vi.fn().mockResolvedValueOnce({ rows: [{ total: '100.00' }] }).mockResolvedValueOnce({ rows: [{ total: '100.004' }] }) };
    const result = await new ReconciliationService().reconcileAcquisition(client, '2026-01-01', 'GL');
    expect(result.status).toBe('MATCHED');
  });
  it('records a mismatch as a fail-closed settlement and clearing block', async () => {
    const client: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await new ReconciliationService().saveReconciliation(client, { gl: 'GL', rail: 'rail', expectedBalance: 100, actualBalance: 90, difference: 10, status: 'MISMATCH' }, '2026-01-01');
    const params = client.query.mock.calls[0][1];
    expect(params.at(-1)).toBe(true);
    expect(JSON.parse(params.at(-2))).toMatchObject({ difference: 10 });
  });
  it('uses the schema unique identity for reconciliation upserts without an expression target', async () => {
    const client: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const service = new ReconciliationService();
    await service.saveReconciliation(client, { gl: 'GL A', rail: 'rail-a', expectedBalance: 0, actualBalance: 0, difference: 0, status: 'MATCHED' }, '2026-01-01');
    await service.saveReconciliation(client, { gl: 'GL A', rail: 'rail-a', expectedBalance: 1, actualBalance: 1, difference: 0, status: 'MATCHED' }, '2026-01-01');
    await service.saveReconciliation(client, { gl: 'GL B', rail: 'rail-a', expectedBalance: 0, actualBalance: 0, difference: 0, status: 'MATCHED' }, '2026-01-01');
    const sql = client.query.mock.calls[0][0];
    expect(sql).toContain('ON CONFLICT (reconciliation_date, gl_name, rail) DO UPDATE');
    expect(sql).not.toContain('COALESCE(rail');
    expect(client.query.mock.calls.map((call: any[]) => call[1].slice(0, 3))).toEqual([
      ['2026-01-01', 'GL A', 'rail-a'],
      ['2026-01-01', 'GL A', 'rail-a'],
      ['2026-01-01', 'GL B', 'rail-a'],
    ]);
  });
});
