import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/application/services/pay/points-reservation-service.ts', () => ({ lockPointsOwner: vi.fn() }));

import { cancelPointsBenefits, recordMerchantPointsConsumption } from '../../src/application/services/pay/points-benefits-service.ts';
import { valueConsumedPointsK } from '../../src/application/services/points-k-valuation-service.ts';

const query = vi.fn();
const db = { query } as any;
const input = {
  operationKey: 'consume-1', partyId: 'party-1', merchantId: 'merchant-1', legalEntityId: null, quantity: 10,
  transactionAmountMinor: 6560, transactionCurrency: 'XAF', paymentValuationProofHash: 'b'.repeat(64),
  kTransactionId: 'k-tx', monetaryTransactionId: 'm-tx', reservationId: 'hold-1', rail: 'qr', paymentCountry: 'CG',
};

function database(options: { eligible: boolean; rateBps: number | null }) {
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT * FROM konektag.points_merchant_consumptions')) return { rows: [] };
    if (sql.includes('merchant_points_benefit_eligibility')) return { rows: options.eligible ? [{ approval_reference: 'APPROVAL-1' }] : [] };
    if (/merchant_payment_commission_rules|legal_entities|merchant_points_bonuses|konektag_revenue_attributions|outbox_events/.test(sql)) throw new Error('Payment must not resolve commission or accounting owner');
    if (sql.includes('payment_country_k_cashback_rules')) return { rows: options.rateBps === null ? [] : [{ rate_bps: options.rateBps, frappe_reference: 'RULE-1' }] };
    if (sql.includes('INSERT INTO konektag.points_merchant_consumptions')) {
      const rate = params[14] as number | null;
      return { rows: [{ id: 'consumption-1', eligible: params[10], k_value_amount: params[5], k_value_currency: params[6],
        cashback_amount: rate === null ? null : String(Number(params[5]) * rate / 10000), cashback_currency: rate === null ? null : params[6] }] };
    }
    return { rows: [] };
  });
}
const insertParams = () => query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO konektag.points_merchant_consumptions'))![1] as unknown[];
const inserted = (table: string) => query.mock.calls.filter(([sql]) => String(sql).includes(`INSERT INTO konektag.${table}`));

describe('Points K consumption value dimensions and cashback base', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('values consumed K from the official parity, never from the transaction amount', () => {
    expect(valueConsumedPointsK(10)).toEqual({ amount: '10.00', currency: 'EUR', version: 'K_EUR_PARITY_1' });
    expect(() => valueConsumedPointsK(0)).toThrow('POINTS_K_QUANTITY_INVALID');
  });

  it('records the K quantity, the XAF transaction and the EUR K value as separate dimensions', async () => {
    database({ eligible: true, rateBps: 25 });
    await recordMerchantPointsConsumption(db, input);
    const params = insertParams();
    expect(params[4]).toBe(10);                // quantity_k_consumed
    expect(params[5]).toBe('10.00');           // k_value_amount (and version 2 merchant_value)
    expect(params[6]).toBe('EUR');             // k_value_currency, cashback_currency
    expect(params[15]).toBe(6560);             // transaction_amount_minor
    expect(params[16]).toBe('XAF');            // transaction_currency
    expect(params[17]).toBe('K_EUR_PARITY_1'); // k_valuation_version
    expect(params[18]).toBe('b'.repeat(64));   // payment_valuation_proof_hash
    expect(params).not.toContain('6560');
  });

  it('grants the cashback on the K value in EUR as a fee credit, not on the XAF amount', async () => {
    database({ eligible: true, rateBps: 25 });
    await recordMerchantPointsConsumption(db, input);
    const [feeCredit] = inserted('fee_credits');
    expect(feeCredit[1]).toEqual(['consumption-1', 'party-1', 'EUR', 25, '0.025', 'fee-credit:consumption-1']);
    expect(inserted('merchant_points_bonuses')).toHaveLength(0);
  });

  it('records neither user cashback nor merchant bonus when the merchant is not benefit-eligible', async () => {
    database({ eligible: false, rateBps: 25 });
    await recordMerchantPointsConsumption(db, input);
    expect(insertParams()[14]).toBeNull();
    expect(inserted('fee_credits')).toHaveLength(0);
    expect(inserted('merchant_points_bonuses')).toHaveLength(0);
    expect(inserted('konektag_revenue_attributions')).toHaveLength(0);
  });

  it.each(['qr', 'payment_link'])('never executes compensation on %s without a cashback rule', async (rail) => {
    database({ eligible: true, rateBps: null });
    await recordMerchantPointsConsumption(db, { ...input, rail });
    expect(insertParams()[14]).toBeNull();
    expect(inserted('fee_credits')).toHaveLength(0);
    expect(inserted('merchant_points_bonuses')).toHaveLength(0);
    expect(inserted('outbox_events')).toHaveLength(0);
  });

  it('never grants a cashback or a merchant bonus on the internal API checkout rail', async () => {
    database({ eligible: true, rateBps: 25 });
    await recordMerchantPointsConsumption(db, { ...input, rail: 'internal', paymentCountry: null });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('payment_country_k_cashback_rules'))).toBe(false);
    expect(insertParams()[14]).toBeNull();
    expect(inserted('fee_credits')).toHaveLength(0);
    expect(inserted('merchant_points_bonuses')).toHaveLength(0);
    expect(inserted('outbox_events')).toHaveLength(0);
  });

  it('requires the resolved payment country on a cashback rail', async () => {
    database({ eligible: true, rateBps: 25 });
    await expect(recordMerchantPointsConsumption(db, { ...input, paymentCountry: null })).rejects.toThrow('PAYMENT_COUNTRY_REQUIRED');
  });

  describe('cancellation', () => {
    const cancel = (bonusRows: unknown[]) => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM konektag.points_merchant_refunds')) return { rows: [] };
        if (sql.includes('SELECT party_id')) return { rows: [{ party_id: 'party-1' }] };
        if (sql.includes("SET status='cancelled'")) return { rows: [{ id: 'consumption-1', eligible: true, monetary_transaction_id: 'm-tx' }] };
        if (sql.includes('UPDATE konektag.merchant_points_bonuses')) return { rows: bonusRows };
        return { rows: [] };
      });
      return cancelPointsBenefits(db, 'consumption-1');
    };
    it('requests no bonus reversal for an eligible internal checkout consumption without bonus', async () => {
      await cancel([]);
      expect(inserted('outbox_events')).toHaveLength(0);
    });
    it('preserves cancellation of an existing historical bonus', async () => {
      await cancel([{ id: 'bonus-1' }]);
      expect(inserted('outbox_events')).toHaveLength(1);
      expect(String(inserted('outbox_events')[0][0])).toContain('PointsMerchantBonusReversalRequested');
    });
  });
});
