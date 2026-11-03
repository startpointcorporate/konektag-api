import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), submit: vi.fn(),
}));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/infrastructure/adapters/erpnext-adapter.ts', () => ({
  erpnext: { list: mocks.list, get: mocks.get, create: mocks.create, submit: mocks.submit },
}));
vi.mock('../../src/application/services/exchange-rate-service.ts', () => ({
  exchangeRateService: { isSupported: () => true, convert: vi.fn(async () => ({ rate: 1 })) },
}));

import { ErpNextAccountingDestination } from '../../src/infrastructure/adapters/accounting-destination.ts';

const orderId = '11111111-1111-4111-8111-111111111111';
const buyerId = '22222222-2222-4222-8222-222222222222';
const entries = (amount: number) => [
  { accountCode: '7000', side: 'debit' as const, amount, amountUnit: 'MINOR' as const, currency: 'EUR', description: null },
  { accountCode: '3000', side: 'credit' as const, amount, amountUnit: 'MINOR' as const, currency: 'EUR', description: null },
];
const transaction = (currency: string, corridor: string) => ({
  id: 'transaction-1', transaction_type: 'fee_collection', business_reference: orderId,
  currency, amount_unit: 'MINOR', merchant_profile_id: buyerId,
  legal_entity_id: `entity-${corridor}`, regulatory_profile_id: `profile-${corridor}`,
  corridor_id: corridor,
});

const configs: Record<string, { code: string; company: string; abbr: string; currency: string; provider: string; debit: string; credit: string }> = {
  FR: { code: 'KTG-FR', company: 'Konektag France', abbr: 'KTF', currency: 'EUR', provider: 'stripe',
    debit: '5115 - Compensation Stripe - KTF', credit: '7061 - Abonnements Pro - KTF' },
  CG: { code: 'KTG-CG', company: 'Konektag Congo', abbr: 'KTC', currency: 'XAF', provider: 'pawapay',
    debit: '5188-Compensation PawaPay - KTC', credit: '7066-Abonnements Pro - KTC' },
  CM: { code: 'KTG-CM', company: 'Konektag Cameroun', abbr: 'KTCM', currency: 'XAF', provider: 'pawapay',
    debit: '5188-Compensation PawaPay - KTCM', credit: '7066-Abonnements Pro - KTCM' },
  GA: { code: 'KTG-GA', company: 'Konektag Gabon', abbr: 'KTGA', currency: 'XAF', provider: 'pawapay',
    debit: '5188-Compensation PawaPay - KTGA', credit: '7066-Abonnements Pro - KTGA' },
};
function configuredDocument(doctype: string, name: string) {
  const corridor = Object.keys(configs).find(key => name === `profile-${key}` || name === configs[key].company
    || name === configs[key].debit || name === configs[key].credit) ?? 'FR';
  const config = configs[corridor];
  if (doctype === 'Company') return { abbr: config.abbr, default_currency: config.currency };
  if (doctype === 'Konektag Regulatory Profile') return { status: 'Approved', legal_entity: config.code,
    corridor, rail: corridor === 'FR' ? 'stripe' : 'mobile_money', runtime_provider: config.provider,
    custom_pro_subscription_debit_account: config.debit,
    custom_pro_subscription_credit_account: config.credit,
    custom_pro_subscription_cost_center: `Main - ${config.abbr}` };
  if (doctype === 'Account') return { company: config.company, account_currency: config.currency,
    root_type: name === config.debit ? 'Asset' : 'Income', is_group: 0, disabled: 0 };
  return null;
}

describe('Pro renewal Frappe journal entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockImplementation(async (doctype: string, filters: { name?: string }) =>
      doctype === 'Cost Center' ? [{ name: filters.name }] : []);
    mocks.get.mockImplementation(async (doctype: string, name: string) => configuredDocument(doctype, name));
    mocks.create.mockResolvedValue({ name: 'JE-1' });
    mocks.submit.mockResolvedValue({ name: 'JE-1' });
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM konektag.regulatory_profiles')) return { rows: [{
        id: params[2], code: configs[params[1] as string].code,
        frappe_company: configs[params[1] as string].company,
        profile_code: `profile-${params[1]}`, rail: params[1] === 'FR' ? 'stripe' : 'mobile_money',
      }] };
      if (sql.includes('FROM konektag.merchant_pro_renewal_intents')) return { rows: [{
        merchant_profile_id: buyerId, subscription_type: 'annual',
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it.each([
    ['FR', 'EUR', 8900, 'Konektag France', '89.00'],
    ['FR', 'EUR', 101460, 'Konektag France', '1014.60'],
    ['CG', 'XAF', 58380, 'Konektag Congo', '58380'],
    ['CG', 'XAF', 665534, 'Konektag Congo', '665534'],
    ['CM', 'XAF', 58380, 'Konektag Cameroun', '58380'],
    ['GA', 'XAF', 58380, 'Konektag Gabon', '58380'],
  ])('posts %s renewal for the buyer and corridor entity', async (corridor, currency, amount, company, expectedAmount) => {
    const result = await new ErpNextAccountingDestination().post(
      transaction(currency, corridor) as any, entries(amount).map(e => ({ ...e, currency })));
    expect(result.success).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith('Journal Entry', expect.objectContaining({
      company,
      user_remark: expect.stringContaining(`buyer_merchant_profile_id=${buyerId}`),
      cost_center: `Main - ${configs[corridor].abbr}`,
      accounts: expect.arrayContaining([expect.objectContaining({ debit_in_account_currency: expectedAmount })]),
    }));
    expect(mocks.create.mock.calls[0][1].accounts[0].cost_center).toBe(`Main - ${configs[corridor].abbr}`);
    expect(mocks.create.mock.calls[0][1].accounts[0].account).toBe(configs[corridor].debit);
    expect(mocks.create.mock.calls[0][1].user_remark).toContain(`corridor_id=${corridor}`);
    expect(mocks.create.mock.calls[0][1].accounts[1].account).toBe(configs[corridor].credit);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('FROM konektag.api_payment_orders'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('FROM konektag.accounting_entry_guides'))).toBe(false);
  });

  it('refuses to write a corridor amount into a company with a different base currency', async () => {
    mocks.get.mockResolvedValue({ abbr: 'KTC', default_currency: 'EUR' });
    const result = await new ErpNextAccountingDestination().post(
      transaction('XAF', 'CG') as any, entries(58380).map(e => ({ ...e, currency: 'XAF' })));
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not match Frappe company');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('requires a real cost center in the corridor company', async () => {
    mocks.list.mockImplementation(async (doctype: string, filters: { name?: string }) =>
      doctype === 'Cost Center' ? [] : doctype === 'Account' ? [{ name: filters.name }] : []);
    const result = await new ErpNextAccountingDestination().post(transaction('EUR', 'FR') as any, entries(8900));
    expect(result.success).toBe(false);
    expect(result.error).toContain('cost center Main - KTF');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a corridor that does not match the frozen regulatory profile', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(new ErpNextAccountingDestination().post(transaction('EUR', 'FR') as any, entries(8900)))
      .rejects.toThrow('no Frappe company for its frozen corridor');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects an Frappe profile assigned to another corridor', async () => {
    mocks.get.mockImplementation(async (doctype: string, name: string) => doctype === 'Konektag Regulatory Profile'
      ? { ...configuredDocument(doctype, name), corridor: 'KTG-GA-KTG-GA' }
      : configuredDocument(doctype, name));
    const result = await new ErpNextAccountingDestination().post(transaction('EUR', 'FR') as any, entries(8900));
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not match the frozen corridor');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a buyer mismatch before writing to Frappe', async () => {
    const result = await new ErpNextAccountingDestination().post(
      { ...transaction('EUR', 'FR'), merchant_profile_id: 'wrong-buyer' } as any, entries(8900));
    expect(result.success).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not fall back to the commission account when the subscription account is missing', async () => {
    mocks.get.mockImplementation(async (doctype: string, name: string) =>
      doctype === 'Account' && name === configs.FR.credit ? null : configuredDocument(doctype, name));
    const result = await new ErpNextAccountingDestination().post(transaction('EUR', 'FR') as any, entries(8900));
    expect(result.success).toBe(false);
    expect(result.error).toContain(`Pro account ${configs.FR.credit} is unavailable`);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not accept an existing voucher for a different buyer', async () => {
    mocks.list.mockImplementation(async (doctype: string, filters: { name?: string }) =>
      doctype === 'Journal Entry' ? [{ name: 'JE-1' }] : [{ name: filters.name }]);
    mocks.get.mockImplementation(async (doctype: string, name: string) => doctype === 'Journal Entry'
      ? { company: 'Konektag France', user_remark: 'buyer_merchant_profile_id=other', docstatus: 1 }
      : configuredDocument(doctype, name));
    const result = await new ErpNextAccountingDestination().post(transaction('EUR', 'FR') as any, entries(8900));
    expect(result.success).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('submits a matching draft voucher found on retry', async () => {
    mocks.list.mockImplementation(async (doctype: string, filters: { name?: string }) =>
      doctype === 'Journal Entry' ? [{ name: 'JE-1' }] : [{ name: filters.name }]);
    mocks.get.mockImplementation(async (doctype: string, name: string) => doctype === 'Journal Entry'
      ? { company: 'Konektag France',
        user_remark: `buyer_merchant_profile_id=${buyerId} | corridor_id=FR`, docstatus: 0 }
      : configuredDocument(doctype, name));
    const result = await new ErpNextAccountingDestination().post(transaction('EUR', 'FR') as any, entries(8900));
    expect(result.success).toBe(true);
    expect(mocks.submit).toHaveBeenCalledWith('Journal Entry', 'JE-1');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
