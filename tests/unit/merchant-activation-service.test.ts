import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query } }));
import { merchantActivationService } from '../../src/application/services/merchant-activation-service.ts';

describe('merchant activation approval predicates', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects an unknown merchant profile', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(merchantActivationService.requireMerchantApproved('merchant-1')).resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('NOT_FOUND') }));
  });
  it('approves exactly MERCHANT_APPROVED without unrelated evidence', async () => {
    query.mockResolvedValue({ rows: [{ kyb_status: 'MERCHANT_APPROVED', kyb_contract_ref: null, kyb_settlement_account: null, kyb_risk_category: null }] });
    await expect(merchantActivationService.requireMerchantApproved('merchant-1')).resolves.toEqual({ ok: true });
  });
  it('rejects a non-approved KYB status with its missing evidence classification', async () => {
    query.mockResolvedValue({ rows: [{ kyb_status: 'DOCUMENTS_SUBMITTED', kyb_contract_ref: null, kyb_settlement_account: null, kyb_risk_category: null }] });
    await expect(merchantActivationService.requireMerchantApproved('merchant-1')).resolves.toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('kyb_documents') }));
  });
  it('classifies missing contract settlement and risk evidence for a non-approved merchant', async () => {
    query.mockResolvedValue({ rows: [{ kyb_status: 'UBO_VERIFIED', kyb_contract_ref: null, kyb_settlement_account: null, kyb_risk_category: null }] });
    await expect(merchantActivationService.checkActivation('merchant-1')).resolves.toEqual(expect.objectContaining({ canOperate: false, missingGates: expect.arrayContaining(['contract_signed', 'settlement_account', 'risk_assessment']) }));
  });
});
