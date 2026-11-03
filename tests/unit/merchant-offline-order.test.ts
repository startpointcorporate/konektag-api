import { describe, expect, it } from 'vitest';
import { generateSigningKey } from '../../src/application/shared/core02/crypto.ts';
import { createMerchantOfflineOrder, validateMerchantOfflineCart } from '../../src/application/shared/offline-pay/merchant-order.ts';

const ids = { merchant: '11111111-1111-4111-8111-111111111111', owner: '22222222-2222-4222-8222-222222222222', device: '33333333-3333-4333-8333-333333333333', key: '44444444-4444-4444-8444-444444444444', offer: '55555555-5555-4555-8555-555555555555', pricing: '66666666-6666-4666-8666-666666666666', authority: '77777777-7777-4777-8777-777777777777' };
const valuation = { sourceCurrency: 'XAF', sourceAmountMinor: 100000, rate: '0.001524390', eurAmountMinor: 15244, quantityK: 152, matrixVersion: 2, validFrom: '2026-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z', authorityId: ids.authority, approvalSource: 'FRONT_LEGACY_RATE_TABLE', proofHash: 'a'.repeat(64) };
const line = (quantity = 1) => ({ offerId: ids.offer, pricingRuleId: ids.pricing, name: 'Offre', quantity, amountMinor: 100000, currency: 'XAF', marketCountry: 'CM', legalEntity: 'KONEKTAG-CM', minQuantity: 1, maxQuantity: 2, pricingVersion: 7, offlineValuations: [{ ...valuation, quantity, unitPriceMinor: 100000 }] });

describe('merchant offline order', () => {
  it('refuses a cart without an approved snapshot valuation', () => {
    expect(() => validateMerchantOfflineCart([{ ...line(), offlineValuations: [] }])).toThrow('POINTS_K_VALUATION_UNAVAILABLE');
    expect(() => validateMerchantOfflineCart([{ ...line(), quantity: 3 }])).toThrow('OFFLINE_QUANTITY_OUT_OF_RANGE');
  });

  it('signs the order with the valuation proof and quantity K from the snapshot', async () => {
    const keys = await generateSigningKey();
    const result = await createMerchantOfflineOrder({ merchantProfileId: ids.merchant, merchantCertificate: { ownerUserId: ids.owner, deviceId: ids.device, keyId: ids.key, keyVersion: 1 }, cart: [line()], now: 1700000000, sign: keys.privateKey });
    expect(result.order.quantityK).toBe(152);
    expect(result.order.sourceAmountMinor).toBe(100000);
    expect(result.order.matrixVersion).toBe(2);
    expect(result.order.orderValuationProofHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.proof.split('.')).toHaveLength(3);
    expect(result.orderHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
