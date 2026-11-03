import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), postTransaction: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { connect: mocks.connect } }));
vi.mock('../../src/application/services/accounting-service.ts', () => ({ accountingService: { postTransaction: mocks.postTransaction } }));
import { settlementService, TrustedSettlementEvidence } from '../../src/application/services/settlement-service.ts';

describe('settlement proof finalization', () => {
  it('fails closed before any state transition when proof URL is missing', async () => {
    const result = await settlementService.confirmSettlement({ settlementId: 's1', confirmedBy: 'u1', evidenceType: 'bank_statement', evidenceUrl: 'not-a-proof' } as any);
    expect(result).toMatchObject({ ok: false, error: 'SETTLEMENT_TRUSTED_EVIDENCE_REQUIRED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('rejects arbitrary non-authoritative proof identifiers before finalization', async () => {
    const result = await settlementService.confirmSettlement({ settlementId: 's1', confirmedBy: 'u1', evidenceType: 'other', evidenceUrl: 'client-proof', contentHash: 'a'.repeat(64), trustedEvidence: true } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('SETTLEMENT_TRUSTED_EVIDENCE_REQUIRED');
  });
  it('posts and finalizes only after a persisted authoritative proof', async () => {
    const settlement = { id: 's1', status: 'APPROVED', version: 1, settlement_ref: 'SET-1', currency: 'XAF', net_amount: '100', merchant_profile_id: 'merchant-1', legal_entity_id: 'entity-cg', period_end: '2026-08-04' };
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('COUNT(DISTINCT ft.regulatory_profile_id)')) return { rows: [{ regulatory_profile_id: 'profile-1', profile_count: '1', missing_count: '0' }] };
      if (sql.includes('FROM konektag.merchant_settlements')) return { rows: [settlement] };
      if (sql.includes('SELECT country_code, base_currency FROM konektag.legal_entities')) return { rows: [{ country_code: 'CG', base_currency: 'XAF' }] };
      if (sql.includes('JOIN konektag.parties p')) return { rows: [{ id: 'merchant-party-1' }] };
      if (sql.includes('MIN(ft.corridor_id)')) return { rows: [{ corridor_id: 'CG-CG', eligibility_decision: 'ALLOWED' }] };
      if (sql.includes('INSERT INTO konektag.settlement_evidence')) return { rows: [{ id: 'proof-1' }] };
      if (sql.includes("SET status = 'BANK_PENDING'")) return { rows: [{ version: 2 }] };
      if (sql.includes("SET status = 'SETTLED'")) return { rows: [{ id: 's1' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    mocks.postTransaction.mockResolvedValue({ success: true });
    const result = await settlementService.confirmSettlement(TrustedSettlementEvidence.fromVerifiedServerSource({ settlementId: 's1', confirmedBy: 'server-operator', evidenceType: 'psp_confirm', evidenceUrl: 'https://provider.example/proof-1', contentHash: 'a'.repeat(64) }));
    expect(result).toEqual({ ok: true });
    expect(mocks.postTransaction).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ regulatedExecutionRef: 'https://provider.example/proof-1', legalEntityId: 'entity-cg', corridorId: 'CG-CG', regulatoryProfileId: 'profile-1' }), entries: expect.arrayContaining([expect.objectContaining({ accountCode: '2000', partyId: 'merchant-party-1' })]) }), expect.anything());
    const evidenceCall = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO konektag.settlement_evidence'))!;
    expect(evidenceCall[1]).toContain('server-operator');
    expect(query.mock.invocationCallOrder.find((_, i) => query.mock.calls[i][0].includes("SET status = 'SETTLED'"))!).toBeGreaterThan(mocks.postTransaction.mock.invocationCallOrder[0]);
  });
  it('rejects caller-supplied URL, hash, and trustedEvidence fields without opening a database transaction', async () => {
    mocks.connect.mockClear();
    const result = await settlementService.confirmSettlement({ settlementId: 's1', confirmedBy: 'attacker', evidenceType: 'psp_confirm', evidenceUrl: 'https://attacker.example/proof', contentHash: 'a'.repeat(64), trustedEvidence: true } as any);
    expect(result).toEqual({ ok: false, error: 'SETTLEMENT_TRUSTED_EVIDENCE_REQUIRED' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('rejects an invalid settlement ValueDate before serializing a projection', async () => {
    const client = { query: vi.fn() };
    await expect(settlementService.projectManualPayoutEvent(client as any, {
      settlement: { id: 's1', period_end: '2026-02-30' }, actorId: 'operator',
      eventType: 'MERCHANT_SETTLEMENT_BANK_PENDING', sourceReference: 'payout-1',
    })).rejects.toThrow('SETTLEMENT_VALUE_DATE_INVALID');
    expect(client.query).not.toHaveBeenCalled();
  });
});
