import { beforeEach, describe, expect, it, vi } from 'vitest';

const merchantProfileId = '11111111-1111-4111-8111-111111111111';
const emptyPayResponse = { settlements: [], summary: { availableBalance: 0, nextDueDate: null } };

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));

import { GET as getPaySettlements } from '../../src/api/routes/pay/settlements.ts';
import { GET as getPaymentLinks } from '../../src/api/routes/pay/payment-links.ts';
import { GET as getMerchantSettlements } from '../../src/api/routes/merchant/settlements/index.ts';

describe('merchant establishment route resolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('COALESCE(SUM(net_amount)')
        ? [{ available_balance: '0', next_due_date: null }]
        : sql.includes('merchant_settlements') || sql.includes('checkout_intents')
        ? []
        : [{ id: merchantProfileId }],
    }));
  });

  it.each([
    ['pay settlements', getPaySettlements, 50, 'settlements'],
    ['payment links', getPaymentLinks, null, 'links'],
    ['merchant settlements', getMerchantSettlements, 30, 'data'],
  ])('scopes %s to the authenticated user mapping', async (_name, handler, limit, responseKey) => {
    const response = await handler({
      locals: { user: { id: 'user-1', keycloak_id: 'legacy-keycloak-id' } },
      url: new URL(`http://localhost/api/test${_name === 'pay settlements' ? '?merchantProfileId=' + merchantProfileId : ''}`),
    } as any);

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('merchant_memberships'),
      limit === null ? ['user-1'] : _name === 'pay settlements' ? [merchantProfileId, 'user-1', limit] : ['user-1', limit],
    );
    if (limit === null) expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('checkout_intents'), ['user-1']);
    if (_name === 'pay settlements') {
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("mm.role IN ('owner', 'manager')"), [merchantProfileId, 'user-1']);
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('ms.merchant_profile_id::text = $1'), [merchantProfileId, 'user-1', 50]);
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('COALESCE(SUM(net_amount)'), [merchantProfileId]);
    }
    expect(await response.json()).toEqual(_name === 'pay settlements' ? emptyPayResponse : { [responseKey]: [] });
  });

  it('rejects a settlement scope not owned or managed by the authenticated user', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await getPaySettlements({
      url: new URL(`http://localhost/api/pay/settlements?merchantProfileId=${merchantProfileId}`),
      locals: { user: { id: 'user-1' } },
    } as any);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'MERCHANT_SCOPE_FORBIDDEN' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("mm.role IN ('owner', 'manager')"), [merchantProfileId, 'user-1']);
  });

  it('returns the existing empty settlement contracts when no scoped records exist', async () => {
    const payResponse = await getPaySettlements({ url: new URL(`http://localhost/api/pay/settlements?merchantProfileId=${merchantProfileId}`), locals: { user: { id: 'user-1' } } } as any);
    const merchantResponse = await getMerchantSettlements({ locals: { user: { id: 'user-1' } } } as any);

    expect(payResponse.status).toBe(200);
    expect(await payResponse.json()).toEqual(emptyPayResponse);
    expect(await merchantResponse.json()).toEqual({ data: [] });
  });
});
