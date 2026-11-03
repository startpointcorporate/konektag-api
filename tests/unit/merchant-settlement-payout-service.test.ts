import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), confirm: vi.fn(), project: vi.fn(), reconcile: vi.fn(), save: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { connect: mocks.connect, query: mocks.query } }));
vi.mock('../../src/application/services/settlement-service.ts', () => ({ settlementService: { confirmSettlement: mocks.confirm, projectManualPayoutEvent: mocks.project }, TrustedSettlementEvidence: { fromVerifiedServerSource: vi.fn(input => ({ input })) } }));
vi.mock('../../src/application/services/reconciliation-service.ts', () => ({ ReconciliationService: class { reconcileSettlementBank = mocks.reconcile; saveReconciliation = mocks.save; } }));

import { merchantSettlementPayoutService } from '../../src/application/services/merchant-settlement-payout-service.ts';

const settlement = { id: 'settlement-1', status: 'APPROVED', approved_by: 'approver-1', merchant_profile_id: 'merchant-1', legal_entity_id: 'entity-1', net_amount: '100', currency: 'XAF', period_end: '2026-08-05' };
const account = { id: 'account-1', merchant_profile_id: 'merchant-1', legal_entity_id: null, payment_method: 'MOBILE_MONEY', provider_account_reference: 'merchant-wallet' };

describe('manual ERP merchant settlement payouts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts an APPROVED settlement with a merchant destination independent of Legal Entity', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('merchant_settlements')) return { rows: [settlement] };
      if (sql.includes('merchant_settlement_configurations')) return { rows: [account] };
      if (sql.includes('merchant_settlement_payouts WHERE')) return { rows: [] };
      if (sql.includes('INSERT INTO konektag.merchant_settlement_payouts')) return { rows: [{ id: 'payout-1' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    await expect(merchantSettlementPayoutService.startManualPayout({ settlementId: 'settlement-1', makerId: 'maker-1', rail: 'MOBILE_MONEY' })).resolves.toEqual({ payoutId: 'payout-1', status: 'BANK_PENDING', idempotent: false });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status='BANK_PENDING'"), ['settlement-1']);
  });

  it('returns the existing payout without creating a second instruction', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('merchant_settlements')) return { rows: [settlement] };
      if (sql.includes('merchant_settlement_configurations')) return { rows: [account] };
      if (sql.includes('merchant_settlement_payouts WHERE')) return { rows: [{ id: 'payout-1', status: 'BANK_PENDING' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    await expect(merchantSettlementPayoutService.startManualPayout({ settlementId: 'settlement-1', makerId: 'maker-1', rail: 'MOBILE_MONEY' })).resolves.toEqual({ payoutId: 'payout-1', status: 'BANK_PENDING', idempotent: true });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO konektag.merchant_settlement_payouts'), expect.anything());
  });

  it('rejects non-approved settlements and approval self-starts', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('merchant_settlements') ? { rows: [{ ...settlement, status: 'PREPARED' }] } : { rows: [] });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    await expect(merchantSettlementPayoutService.startManualPayout({ settlementId: 'settlement-1', makerId: 'maker-1', rail: 'BANK' })).rejects.toThrow('SETTLEMENT_NOT_APPROVED');
    query.mockImplementation(async (sql: string) => sql.includes('merchant_settlements') ? { rows: [settlement] } : { rows: [] });
    await expect(merchantSettlementPayoutService.startManualPayout({ settlementId: 'settlement-1', makerId: 'approver-1', rail: 'BANK' })).rejects.toThrow('MAKER_CHECKER_VIOLATION');
  });

  it('refuses incomplete or inconsistent proof before it becomes verifiable', async () => {
    await expect(merchantSettlementPayoutService.submitManualProof({ payoutId: 'payout-1', submittedBy: 'maker-1', operatorReference: '', valueDate: '2026-08-05', amount: 100, currency: 'XAF', filename: 'proof.pdf', documentBase64: 'cHJvb2Y=' })).rejects.toThrow('SETTLEMENT_PROOF_INCOMPLETE');
    const query = vi.fn(async (sql: string) => sql.includes('merchant_settlement_payouts') ? { rows: [{ id: 'payout-1', status: 'BANK_PENDING', settlement_status: 'BANK_PENDING', net_amount: '100', currency: 'XAF' }] } : { rows: [] });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    await expect(merchantSettlementPayoutService.submitManualProof({ payoutId: 'payout-1', submittedBy: 'maker-1', operatorReference: 'BANK-1', valueDate: '2026-08-05', amount: 101, currency: 'XAF', filename: 'proof.pdf', documentBase64: 'cHJvb2Y=' })).rejects.toThrow('SETTLEMENT_PROOF_AMOUNT_OR_CURRENCY_MISMATCH');
  });

  it('rejects self-validation and preserves rejected proof for correction', async () => {
    const payout = { id: 'payout-1', status: 'AWAITING_VERIFICATION', settlement_id: 'settlement-1', proof_submitted_by: 'maker-1', operator_reference: 'BANK-1', value_date: '2026-08-05', proof_document: Buffer.from('proof'), evidence_hash: 'a'.repeat(64), net_amount: '100', currency: 'XAF', legal_entity_id: 'entity-1', merchant_profile_id: 'merchant-1', provider_account_reference: 'merchant-wallet', rail: 'BANK' };
    const query = vi.fn(async (sql: string) => sql.includes('merchant_settlement_payouts p') ? { rows: [payout] } : { rows: [] });
    mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    await expect(merchantSettlementPayoutService.verifyManualProof({ payoutId: 'payout-1', verifierId: 'maker-1', approved: true })).rejects.toThrow('MAKER_CHECKER_VIOLATION');
    await expect(merchantSettlementPayoutService.verifyManualProof({ payoutId: 'payout-1', verifierId: 'checker-1', approved: false, rejectionReason: 'Reference mismatch' })).resolves.toEqual({ ok: true, status: 'REJECTED' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status='REJECTED'"), expect.arrayContaining(['Reference mismatch', 'checker-1']));
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
