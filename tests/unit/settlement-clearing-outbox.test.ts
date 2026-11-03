import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/application/services/operation-currency-service.ts', () => ({
  resolveLegalEntityCurrency: vi.fn().mockResolvedValue({ country: 'CG', currency: 'XAF' }),
  resolveMerchantOperationCurrency: vi.fn().mockResolvedValue({ country: 'CG', currency: 'XAF', legalEntityId: 'entity-1' }),
}));

const mocks = vi.hoisted(() => ({ connect: vi.fn(), postTransaction: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { connect: mocks.connect } }));
vi.mock('../../src/application/services/accounting-service.ts', () => ({
  accountingService: { postTransaction: mocks.postTransaction },
}));

import { settlementService, TrustedSettlementEvidence } from '../../src/application/services/settlement-service.ts';
import { clearingService } from '../../src/application/services/clearing-service.ts';

const outboxCalls = (query: ReturnType<typeof vi.fn>) =>
  query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO konektag.outbox_events'));

const projectionCall = (query: ReturnType<typeof vi.fn>, eventType: string) =>
  outboxCalls(query).find((call) => call[1]?.includes(eventType))!;

function expectPayload(call: any[], eventType: string, expected: Record<string, unknown>) {
  expect(call[1][3]).toBe(eventType);
  const payload = JSON.parse(call[1][4]);
  expect(payload).toEqual(expected);
  expect(payload).not.toHaveProperty('event_id');
  expect(payload).not.toHaveProperty('operation_id');
  expect(payload).not.toHaveProperty('occurred_at');
}

const merchantPayload = (actor: string) => ({
  Amount: 100, Currency: 'XAF', ValueDate: '2026-08-04', SourceReference: 'SET-1',
  MerchantSettlementBatchId: 'settlement-1', MerchantId: 'merchant-1', LegalEntity: 'entity-1',
  RegulatoryProfileId: 'reg-profile-1', ActorId: actor,
});

const clearingPayload = (actor: string, nettingRequested = true) => ({
  Amount: 25, Currency: 'XAF', ValueDate: '2026-08-04', SourceReference: 'CLR-1',
  ClearingBatchId: 'batch-1', LegalEntity: 'entity-a', CounterpartyEntity: 'entity-b',
  RegulatoryProfileId: 'reg-profile-1', SettlementProfileId: 'profile-1',
  PeriodKey: '2026-08-01/2026-08-04', Corridor: 'FR-CG', ActorId: actor,
  GrossReceivableAmount: 40, GrossPayableAmount: 15, NetReportingAmount: 25, NettingRequested: nettingRequested,
});

const regulatoryFacts = { regulatory_profile_id: 'reg-profile-1', profile_count: '1', missing_count: '0' };
const clearingFacts = { gross_receivable: '40', gross_payable: '15', regulatory_profile_id: 'reg-profile-1', profile_count: '1', missing_profile_count: '0', corridor: 'FR-CG', corridor_count: '1', missing_corridor_count: '0' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postTransaction.mockResolvedValue({ success: true });
});

describe('settlement projection outbox', () => {
  it('inserts PREPARED in the state transaction before commit', async () => {
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('COUNT(DISTINCT ft.regulatory_profile_id)')) return { rows: [regulatoryFacts] };
      if (sql.includes('daily_reconciliations')) return { rows: [] };
      if (sql.includes('FROM konektag.merchant_sales')) return { rows: [{ id: 'sale-1', status: 'CREATED', linked: false, merchant_profile_id: 'merchant-1', legal_entity_id: 'entity-1', currency: 'XAF', gross_amount: '110', net_amount: '100', tax_amount: '5', commission_amount: '5' }] };
      if (sql.includes('INSERT INTO konektag.merchant_settlements')) return { rows: [{ id: 'settlement-1' }] };
      // No QR/Link Pay bonus on this sale: the PostgreSQL compensation total is the sale net.
      if (sql.includes('FROM unnest($1::text[])')) return { rows: [{ bonus: '0', commission: '0', net: '110' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await settlementService.prepareSettlement({ settlementRef: 'SET-1', legalEntityId: 'entity-1', merchantProfileId: 'merchant-1', merchantSaleIds: ['sale-1'], grossAmount: 110, netAmount: 100, currency: 'XAF', rail: 'BANK', railProofRef: 'proof', railProofUrl: 'https://bank/proof', valueDate: '2026-08-04', preparedBy: 'maker-1' });

    expect(outboxCalls(query)).toHaveLength(2);
    expect(outboxCalls(query).some(([sql]) => String(sql).includes('SettlementPrepared'))).toBe(true);
    const eventCall = projectionCall(query, 'MERCHANT_SETTLEMENT_PREPARED');
    expectPayload(eventCall, 'MERCHANT_SETTLEMENT_PREPARED', { ...merchantPayload('maker-1'), Amount: 110, SourceReference: 'proof' });
    expect(query.mock.invocationCallOrder[query.mock.calls.findIndex(call => call === eventCall)]).toBeLessThan(query.mock.invocationCallOrder[query.mock.calls.findIndex(([sql]) => sql === 'COMMIT')]);
  });

  it('inserts APPROVED only with the successful transition', async () => {
    const settlement = { id: 'settlement-1', status: 'PREPARED', version: 1, prepared_by: 'maker-1', settlement_ref: 'SET-1', merchant_profile_id: 'merchant-1', legal_entity_id: 'entity-1', period_end: '2026-08-04', gross_amount: '110', net_amount: '100', currency: 'XAF' };
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('COUNT(DISTINCT ft.regulatory_profile_id)')) return { rows: [regulatoryFacts] };
      if (sql.includes('FROM konektag.merchant_settlements')) return { rows: [settlement] };
      if (sql.includes("SET status = 'APPROVED'")) return { rows: [{ id: settlement.id }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    expect(await settlementService.approveSettlement(settlement.id, 'checker-1', true)).toEqual({ ok: true });
    expectPayload(projectionCall(query, 'MERCHANT_SETTLEMENT_APPROVED'), 'MERCHANT_SETTLEMENT_APPROVED', merchantPayload('checker-1'));
  });

  it('inserts SETTLED after accounting and before commit', async () => {
    const settlement = { id: 'settlement-1', status: 'APPROVED', version: 1, settlement_ref: 'SET-1', merchant_profile_id: 'merchant-1', legal_entity_id: 'entity-1', period_end: '2026-08-04', gross_amount: '110', net_amount: '100', currency: 'XAF' };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('COUNT(DISTINCT ft.regulatory_profile_id)')) return { rows: [regulatoryFacts] };
      if (sql.includes('FROM konektag.merchant_settlements')) return { rows: [settlement] };
      if (sql.includes('INSERT INTO konektag.settlement_evidence')) return { rows: [{ id: 'proof-1' }] };
      if (sql.includes("SET status = 'BANK_PENDING'")) return { rows: [{ version: 2 }] };
      if (sql.includes("SET status = 'SETTLED'")) return { rows: [{ id: settlement.id }] };
      if (sql.includes('JOIN konektag.parties p')) return { rows: [{ id: 'merchant-party-1' }] };
      if (sql.includes('MIN(ft.corridor_id)')) return { rows: [{ corridor_id: 'CG-CG', eligibility_decision: 'ALLOWED' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    expect(await settlementService.confirmSettlement(TrustedSettlementEvidence.fromVerifiedServerSource({ settlementId: settlement.id, confirmedBy: 'operator-1', evidenceType: 'bank_statement', evidenceUrl: 'https://bank/proof', contentHash: 'a'.repeat(64) }))).toEqual({ ok: true });
    expectPayload(projectionCall(query, 'MERCHANT_SETTLEMENT_SETTLED'), 'MERCHANT_SETTLEMENT_SETTLED', {
      ...merchantPayload('operator-1'), PaymentRailReference: 'https://bank/proof',
      SettlementEvidence: 'https://bank/proof', ReconciliationResult: 'Matched',
    });
    expect(query.mock.invocationCallOrder[query.mock.calls.findIndex(([sql]) => String(sql).includes('INSERT INTO konektag.outbox_events'))]).toBeGreaterThan(mocks.postTransaction.mock.invocationCallOrder[0]);
  });
});

describe('clearing projection outbox', () => {
  it('inserts FROZEN with the immutable position summary', async () => {
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('daily_reconciliations') || sql.includes('SELECT id, status')) return { rows: [] };
      if (sql.includes('b2b_settlement_profiles')) return { rows: [{ id: 'profile-1', netting_allowed: true, legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', settlement_currency: 'XAF' }] };
      if (sql.includes('INSERT INTO konektag.clearing_batches')) return { rows: [{ id: 'batch-1' }] };
      if (sql.includes('FROM konektag.intercompany_positions')) return { rows: [{ id: 'position-1', legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', direction: 'B_TO_A', amount: '25', currency: 'XAF' }] };
      if (sql.includes('gross_receivable')) return { rows: [clearingFacts] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await clearingService.freezeBatch({ periodStart: '2026-08-01', periodEnd: '2026-08-04', legalEntityId: 'entity-a', counterpartyEntityId: 'entity-b', currency: 'XAF', b2bProfileId: 'profile-1', initiatedBy: 'maker-1' });
    expectPayload(projectionCall(query, 'CLEARING_FROZEN'), 'CLEARING_FROZEN', { ...clearingPayload('maker-1'), SourceReference: 'CLR-entity-a-entity-b-XAF-2026-08-01-2026-08-04' });
    const factsCall = query.mock.calls.find(([sql]) => sql.includes('gross_receivable'))!;
    expect(factsCall[0]).toContain("ip.direction = 'A_TO_B' AND ip.legal_entity_b_id = $2");
    expect(factsCall[0]).toContain("ip.direction = 'B_TO_A' AND ip.legal_entity_a_id = $2");
    expect(factsCall[1]).toEqual(['batch-1', 'entity-a']);
  });

  it('projects a non-netted batch with its truthful gross Amount', async () => {
    const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.includes('daily_reconciliations') || sql.includes('SELECT id, status')) return { rows: [] };
      if (sql.includes('b2b_settlement_profiles')) return { rows: [{ id: 'profile-1', netting_allowed: false, legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', settlement_currency: 'XAF' }] };
      if (sql.includes('INSERT INTO konektag.clearing_batches')) return { rows: [{ id: 'batch-1' }] };
      if (sql.includes('FROM konektag.intercompany_positions')) return { rows: [
        { id: 'receivable', legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', direction: 'B_TO_A', amount: '40', currency: 'XAF' },
        { id: 'payable', legal_entity_a_id: 'entity-a', legal_entity_b_id: 'entity-b', direction: 'A_TO_B', amount: '15', currency: 'XAF' },
      ] };
      if (sql.includes('gross_receivable')) return { rows: [clearingFacts] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await clearingService.freezeBatch({ periodStart: '2026-08-01', periodEnd: '2026-08-04', legalEntityId: 'entity-a', counterpartyEntityId: 'entity-b', currency: 'XAF', b2bProfileId: 'profile-1', initiatedBy: 'maker-1' });

    expect(query.mock.calls.find(([sql]) => sql.includes('SET gross_amount'))?.[1]).toEqual([55, null, 2, 'batch-1']);
    expectPayload(projectionCall(query, 'CLEARING_FROZEN'), 'CLEARING_FROZEN', {
      ...clearingPayload('maker-1', false), Amount: 55,
      SourceReference: 'CLR-entity-a-entity-b-XAF-2026-08-01-2026-08-04',
    });
  });

  it('inserts APPROVED only when the final required approval changes status', async () => {
    const batch = { id: 'batch-1', status: 'FROZEN', initiated_by: 'maker-1', legal_entity_id: 'entity-a', counterparty_entity_id: 'entity-b', b2b_profile_id: 'profile-1', batch_ref: 'CLR-1', period_start: '2026-08-01', period_end: '2026-08-04', currency: 'XAF', gross_amount: '25', net_amount: '25', netting_allowed: true, finance_a_approved_by: 'finance-a', finance_b_approved_by: 'finance-b', compliance_approved_by: null };
    const updated = { ...batch, compliance_approved_by: 'compliance-1' };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM konektag.clearing_batches')) return { rows: [batch] };
      if (sql.includes('SELECT u.role')) return { rows: [{ role: 'compliance', country: 'CG', country_code: 'CG' }] };
      if (sql.includes('SELECT settlement_currency')) return { rows: [{ settlement_currency: 'XAF' }] };
      if (sql.includes('UPDATE konektag.clearing_batches') && sql.includes('RETURNING *')) return { rows: [updated] };
      if (sql.includes('gross_receivable')) return { rows: [clearingFacts] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await clearingService.approveBatch({ batchId: batch.id, approverId: 'compliance-1' });
    expectPayload(projectionCall(query, 'CLEARING_APPROVED'), 'CLEARING_APPROVED', clearingPayload('compliance-1'));
  });

  it('inserts SETTLED after both authoritative accounting postings', async () => {
    const batch = { id: 'batch-1', status: 'APPROVED', version: 3, source_currency: 'XAF', target_currency: 'XAF', profile_settlement_currency: 'XAF', fx_evidence_id: null, legal_entity_id: 'entity-a', counterparty_entity_id: 'entity-b', b2b_profile_id: 'profile-1', batch_ref: 'CLR-1', period_start: '2026-08-01', period_end: '2026-08-04', currency: 'XAF', gross_amount: '25', net_amount: '25', netting_allowed: true };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM konektag.clearing_batches cb')) return { rows: [batch] };
      if (sql.includes('SELECT code, country_code')) return { rows: [{ code: 'KTG-FR', country_code: 'FR' }] };
      if (sql.includes("SET status = 'SETTLED'")) return { rows: [{ ...batch, status: 'SETTLED' }] };
      if (sql.includes('gross_receivable')) return { rows: [clearingFacts] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });

    await clearingService.markSettled({ batchId: batch.id, bankProofUrl: 'https://bank/proof', settledBy: 'operator-1' });
    expect(mocks.postTransaction).toHaveBeenCalledTimes(2);
    expectPayload(projectionCall(query, 'CLEARING_SETTLED'), 'CLEARING_SETTLED', { ...clearingPayload('operator-1'), SettlementEvidence: 'https://bank/proof' });
  });
});
