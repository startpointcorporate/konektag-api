import { afterEach, describe, expect, it, vi } from 'vitest';

const checkoutMocks = vi.hoisted(() => ({ markFinalAndDispatch: vi.fn(), createMerchantSale: vi.fn() }));
const accountingMocks = vi.hoisted(() => ({ postTransaction: vi.fn() }));
const settlementMocks = vi.hoisted(() => ({ prepareSettlement: vi.fn(), confirmSettlement: vi.fn() }));

vi.mock('../../src/application/services/pay/api-payment-checkout-service.ts', () => ({ apiPaymentCheckoutService: checkoutMocks }));
vi.mock('../../src/application/services/accounting-service.ts', () => ({ accountingService: accountingMocks }));
vi.mock('../../src/application/services/settlement-service.ts', () => ({ settlementService: settlementMocks }));

import { POST as checkoutPost } from '../../src/api/routes/webhooks/pawapay/checkouts.ts';
import { POST as payoutPost } from '../../src/api/routes/webhooks/pawapay/payouts.ts';
import { POST as refundPost } from '../../src/api/routes/webhooks/pawapay/refunds.ts';

describe('PawaPay placeholder webhooks', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['checkouts', checkoutPost],
    ['payouts', payoutPost],
    ['refunds', refundPost],
  ])('returns 501 for %s without financial side effects', async (callbackType, POST) => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const payload = '{"sensitive":"callback payload"}';
    const response = await POST({ request: new Request(`https://www.konektag.eu/api/webhooks/pawapay/${callbackType}`, { method: 'POST', body: payload }) } as any);

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({ error: 'PawaPay callback type not implemented' });
    expect(log).toHaveBeenCalledWith(`PawaPay ${callbackType.slice(0, -1)} callback received but is not implemented`);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(payload));
    expect(checkoutMocks.markFinalAndDispatch).not.toHaveBeenCalled();
    expect(checkoutMocks.createMerchantSale).not.toHaveBeenCalled();
    expect(accountingMocks.postTransaction).not.toHaveBeenCalled();
    expect(settlementMocks.prepareSettlement).not.toHaveBeenCalled();
    expect(settlementMocks.confirmSettlement).not.toHaveBeenCalled();
  });
});
