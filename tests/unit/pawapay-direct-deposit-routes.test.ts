import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ start: vi.fn(), list: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: {} }));
vi.mock('../../src/application/services/pay/pawapay-direct-deposit-service.ts', async () => {
  const actual = await vi.importActual<any>('../../src/application/services/pay/pawapay-direct-deposit-service.ts');
  return { ...actual, startPawaPayDirectDeposit: service.start, listPawaPayDepositProviders: service.list };
});
import { POST } from '../../src/api/routes/pay/checkout/[token]/mobile-money/pawapay/direct-deposit.ts';
import { GET } from '../../src/api/routes/pay/checkout/[token]/mobile-money/pawapay/providers.ts';
import { PawaPayDirectDepositError } from '../../src/application/services/pay/pawapay-direct-deposit-service.ts';
import { ApiPaymentConflictError } from '../../src/application/services/pay/api-payment-checkout-service.ts';
import { PawaPayError } from '../../src/infrastructure/adapters/pawapay-client.ts';
import { PawaPaySandboxPolicyError } from '../../src/infrastructure/adapters/pawapay-sandbox-policy.ts';

const user = { id: 'user-1', keycloak_id: 'kc-1', username: 'payer', email: 'payer@example.test' };
const post = (body: unknown) => POST({ params: { token: 'tok' }, locals: { user },
  request: new Request('https://api.test/x', { method: 'POST', body: JSON.stringify(body) }) } as any);

describe('Points K pawaPay direct deposit routes', () => {
  beforeEach(() => { service.start.mockReset(); service.list.mockReset(); });

  it('starts the deposit for the authenticated payer without accepting any amount', async () => {
    service.start.mockResolvedValue({ outcome: 'awaiting_mobile_money', depositId: 'dep', status: 'ACCEPTED', state: 'awaiting_mobile_money' });
    const response = await post({ phoneNumber: '+242 05 345 6789', provider: 'MTN_MOMO_COG' });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ outcome: 'awaiting_mobile_money', depositId: 'dep' });
    expect(service.start).toHaveBeenCalledWith('tok', { userId: 'user-1', keycloakId: 'kc-1', username: 'payer', email: 'payer@example.test' },
      { phoneNumber: '+242 05 345 6789', provider: 'MTN_MOMO_COG' });
    expect((await post({ phoneNumber: '242053456789', amount: 1 })).status).toBe(400);
    expect((await post({ phoneNumber: 'abc' })).status).toBe(400);
    expect(service.start).toHaveBeenCalledOnce();
  });

  it.each([
    [new PawaPaySandboxPolicyError(), 503, { error: 'PAWAPAY_SANDBOX_DISABLED' }],
    [new PawaPayDirectDepositError('PAWAPAY_DEPOSIT_REJECTED', 422, { failureCode: 'INVALID_AMOUNT' }), 422, { error: 'PAWAPAY_DEPOSIT_REJECTED', failureCode: 'INVALID_AMOUNT' }],
    [new ApiPaymentConflictError('Payment method does not match the ERPNext Points K Mode of Payment'), 409, { error: 'Payment method does not match the ERPNext Points K Mode of Payment' }],
    [new PawaPayError('PawaPay request failed (500)', 500), 502, { error: 'PawaPay request failed (500)' }],
  ])('maps %s to its HTTP status', async (error, status, body) => {
    service.start.mockRejectedValue(error);
    const response = await post({ phoneNumber: '242053456789' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it('lists operators active for the checkout', async () => {
    service.list.mockResolvedValue({ country: 'COG', currency: 'XAF', amount: '8567', providers: [] });
    const response = await GET({ params: { token: 'tok' }, locals: { user } } as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ country: 'COG', currency: 'XAF', amount: '8567', providers: [] });
    service.list.mockRejectedValue(new PawaPayDirectDepositError('PAWAPAY_DIRECT_DEPOSIT_NOT_AVAILABLE', 409));
    expect((await GET({ params: { token: 'tok' }, locals: {} } as any)).status).toBe(409);
  });
});
