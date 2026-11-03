import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostFinancialTransactionCommand } from '../../src/domain/Accounting.ts';

const mocks = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockRelease: vi.fn(),
  mockClient: {} as any,
}));

mocks.mockClient = {
  query: mocks.mockQuery,
  release: mocks.mockRelease,
};

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: {
    connect: mocks.mockConnect,
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

import { accountingService } from '../../src/application/services/accounting-service.ts';

const validCmd: PostFinancialTransactionCommand = {
  idempotencyKey: 'TEST:QR-001:user1:10000',
  transactionType: 'qr_payment',
  businessReference: 'QR-001',
  currency: 'XOF',
  description: 'Test payment',
  metadata: { legalEntityId: 'legal-entity-test' },
  entries: [
    { accountCode: '1000', partyId: 'party-payer', side: 'debit', amount: 10000, description: 'Paiement' },
    { accountCode: '2000', side: 'credit', amount: 9700, description: 'Dette commerçant' },
    { accountCode: '3000', side: 'credit', amount: 300, description: 'Frais' },
  ],
};

describe('accountingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockConnect.mockResolvedValue(mocks.mockClient);
  });

  describe('idempotence', () => {
    it('returns existing transaction when same key and content exists', async () => {
      const pool = (await import('../../src/infrastructure/database/pool.ts')).default;
      (pool.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'tx-001',
          idempotency_key: 'TEST:QR-001:user1:10000',
          transaction_type: 'qr_payment',
          business_reference: 'QR-001',
      currency: 'XOF',
      metadata: { legalEntityId: 'legal-entity-test' },
          status: 'completed',
          accounting_status: 'pending',
          erpnext_voucher_type: null,
          erpnext_voucher_id: null,
          error_message: null,
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          failed_at: null,
          accounting_posted_at: null,
          legal_entity_id: 'legal-entity-test',
          counterparty_entity_id: null,
          corridor_id: null,
          operation_id: null,
          source_operation_id: null,
          position_id: null,
          klot_id: null,
          regulatory_profile_id: null,
          regulated_actor_id: null,
          regulated_execution_ref: null,
          value_date: null,
        }],
      });
      (pool.query as any).mockResolvedValueOnce({
        rows: [
          { account_code: '1000', party_id: 'party-payer', entry_side: 'debit', amount: 10000, description: 'Paiement' },
          { account_code: '2000', party_id: null, entry_side: 'credit', amount: 9700, description: 'Dette commerçant' },
          { account_code: '3000', party_id: null, entry_side: 'credit', amount: 300, description: 'Frais' },
        ],
      });

      const result = await accountingService.postTransaction(validCmd);
      expect(result.success).toBe(true);
      expect(result.created).toBe(false);
      expect(result.financialTransactionId).toBe('tx-001');
    });

    it('rejects when same key with different content exists', async () => {
      const pool = (await import('../../src/infrastructure/database/pool.ts')).default;
      (pool.query as any).mockResolvedValueOnce({
        rows: [{
          id: 'tx-001',
          idempotency_key: 'TEST:QR-001:user1:10000',
          transaction_type: 'qr_payment',
          business_reference: 'QR-001',
      currency: 'XOF',
      metadata: { legalEntityId: 'legal-entity-test' },
          status: 'completed',
          accounting_status: 'posted',
          erpnext_voucher_type: null,
          erpnext_voucher_id: null,
          error_message: null,
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          failed_at: null,
          accounting_posted_at: null,
        }],
      });
      (pool.query as any).mockResolvedValueOnce({
        rows: [
          { account_code: '1000', party_id: 'party-payer', entry_side: 'debit', amount: 5000, description: 'Different' },
          { account_code: '2000', party_id: null, entry_side: 'credit', amount: 4850, description: 'Different' },
        ],
      });

      const result = await accountingService.postTransaction(validCmd);
      expect(result.success).toBe(false);
      expect(result.created).toBe(false);
      expect(result.error).toContain('different content');
    });
  });

  describe('validation', () => {
    it('rejects transaction with zero entries', async () => {
      const result = await accountingService.postTransaction({ ...validCmd, entries: [] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('at least 2 entries');
    });

    it('rejects transaction with single entry', async () => {
      const result = await accountingService.postTransaction({
        ...validCmd, entries: [{ accountCode: '1000', side: 'debit', amount: 10000 }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('at least 2 entries');
    });

    it('rejects entry with zero amount', async () => {
      const result = await accountingService.postTransaction({
        ...validCmd,
        entries: [
          { accountCode: '1000', side: 'debit', amount: 0 },
          { accountCode: '2000', side: 'credit', amount: 0 },
        ],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });

    it('rejects entry with negative amount', async () => {
      const result = await accountingService.postTransaction({
        ...validCmd,
        entries: [
          { accountCode: '1000', side: 'debit', amount: -100 },
          { accountCode: '2000', side: 'credit', amount: 100 },
        ],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });
  });

  describe('double-entry balance', () => {
    function setupBalancedExpectations() {
      // BEGIN + SET LOCAL
      mocks.mockQuery.mockResolvedValueOnce(undefined);
      mocks.mockQuery.mockResolvedValueOnce(undefined);
      // INSERT financial_transactions RETURNING id
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tx-002' }] });
      // 3× INSERT ledger_entry
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      // Balance check
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ total_debit: '10000', total_credit: '10000' }] });
      // UPDATE status = completed
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      // INSERT outbox
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ id: 'outbox-001' }] });
      // UPDATE outbox_event_id
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    }

    it('commits a balanced transaction', async () => {
      setupBalancedExpectations();

      const result = await accountingService.postTransaction(validCmd);
      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(result.financialTransactionId).toBe('tx-002');
    });

    it.each([8900, 101460])('records exact EUR cents in both ledger entries for %i', async amountMinor => {
      mocks.mockQuery.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ id: 'tx-pro' }] })
        .mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total_debit: String(amountMinor), total_credit: String(amountMinor) }] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'outbox-pro' }] })
        .mockResolvedValueOnce({ rowCount: 1 });
      const result = await accountingService.postTransaction({
        idempotencyKey: `PRO-${amountMinor}`, transactionType: 'fee_collection',
        businessReference: `PRO-${amountMinor}`, currency: 'EUR', amountUnit: 'MINOR',
        metadata: { legalEntityId: 'legal-entity-test' },
        entries: [
          { accountCode: '7000', side: 'debit', amount: amountMinor },
          { accountCode: '3000', side: 'credit', amount: amountMinor },
        ],
      });
      expect(result.success).toBe(true);
      const ledgerCalls = mocks.mockQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO konektag.ledger_entries'));
      expect(ledgerCalls).toHaveLength(2);
      expect(ledgerCalls.map(([, args]) => args[5])).toEqual([amountMinor, amountMinor]);
      expect(ledgerCalls.map(([, args]) => args.at(-1))).toEqual(['MINOR', 'MINOR']);
    });

    it('rolls back an unbalanced transaction', async () => {
      mocks.mockQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tx-003' }] });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ total_debit: '10000', total_credit: '9500' }] });

      const result = await accountingService.postTransaction(validCmd);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unbalanced');
    });
  });

  describe('hash determinism', () => {
    it('creates new transaction when different idempotency keys with same content', async () => {
      const pool = (await import('../../src/infrastructure/database/pool.ts')).default;
      (pool.query as any).mockResolvedValue({ rows: [] });

      const cmdA: PostFinancialTransactionCommand = {
        idempotencyKey: 'HASH-A',
        transactionType: 'qr_payment',
        businessReference: 'QR-TEST',
        currency: 'XOF',
        metadata: { legalEntityId: 'legal-entity-test' },
        entries: [
          { accountCode: '1000', partyId: 'party-A', side: 'debit', amount: 5000 },
          { accountCode: '2000', side: 'credit', amount: 4850 },
          { accountCode: '3000', side: 'credit', amount: 150 },
        ],
      };

      mocks.mockQuery.mockResolvedValueOnce(undefined); // BEGIN
      mocks.mockQuery.mockResolvedValueOnce(undefined); // SET LOCAL
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tx-hash-1' }] });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ total_debit: '5000', total_credit: '5000' }] });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      mocks.mockQuery.mockResolvedValueOnce({ rows: [{ id: 'outbox-002' }] });
      mocks.mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await accountingService.postTransaction(cmdA);
      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
    });
  });
});
