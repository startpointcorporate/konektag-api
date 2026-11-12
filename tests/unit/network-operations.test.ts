import { describe, expect, it, vi } from 'vitest';
import { deliverNetworkOperation, enqueueNetworkOperation, enqueueRechargeOperation } from '../../src/application/network-operations/network-operations.ts';

const env = {
  MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({ 'konektag-cg': { site: 'KONEKTAG_CG' }, 'konektag-fr': { site: 'EUROPE' } }),
  MARKETPLACE_FRAPPE_KONEKTAG_CG_URL: 'https://congo.erp.example/', MARKETPLACE_FRAPPE_KONEKTAG_CG_API_KEY: 'k', MARKETPLACE_FRAPPE_KONEKTAG_CG_API_SECRET: 's',
} as NodeJS.ProcessEnv;
const operation = { key: 'recharge:a1', type: 'points_k_recharge' as const, status: 'pending' as const, eventKey: 'recharge:a1:pending', reference: 'a1' };

describe('network operations', () => {
  it('queues one outbox event per notification key, deduplicated by the database', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await enqueueNetworkOperation({ query }, { site: 'CONGO', aggregateId: 'b3c0f2d4-0000-4000-8000-000000000001', operation });
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (aggregate_ref) WHERE event_type = 'NetworkOperationChanged' DO NOTHING");
    expect(values[2]).toBe('recharge:a1:pending');
    expect(JSON.parse(values[4])).toEqual({ site: 'CONGO', operation });
    await expect(enqueueNetworkOperation({ query }, { site: 'congo', aggregateId: 'x', operation })).rejects.toThrow('NETWORK_OPERATION_SITE_INVALID');
  });

  it('routes a Points K recharge to the site of its Konektag slug and ignores other attempts', async () => {
    const row = { attempt_id: 'a1', provider_reference: 'dep-1', expected_amount: '5000', expected_currency: 'XAF',
      created_at: '2026-11-10T08:00:00Z', order_id: 'o1', slug: 'konektag-cg' };
    const query = vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValue({ rows: [] });
    expect(await enqueueRechargeOperation({ query }, { provider: 'pawapay', providerReference: 'dep-1', status: 'failed', failureReason: 'INSUFFICIENT_BALANCE', env })).toBe(true);
    expect(query.mock.calls[0][0]).toContain("o.order_purpose = 'wallet_recharge'");
    const payload = JSON.parse(query.mock.calls[1][1][4]);
    expect(payload).toMatchObject({ site: 'KONEKTAG_CG', operation: { key: 'recharge:a1', status: 'failed', eventKey: 'recharge:a1:failed',
      reference: 'a1', provider: 'pawapay', providerReference: 'dep-1', amount: 5000, currency: 'XAF', orderId: 'o1', failureReason: 'INSUFFICIENT_BALANCE' } });
    // A merchant checkout, or a purchase without a Konektag site: no Network operation.
    const none = vi.fn().mockResolvedValue({ rows: [] });
    expect(await enqueueRechargeOperation({ query: none }, { provider: 'stripe', providerReference: 'pi_1', status: 'paid', env })).toBe(false);
    const noSite = vi.fn().mockResolvedValueOnce({ rows: [{ ...row, slug: 'konektag-lb' }] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await enqueueRechargeOperation({ query: noSite }, { provider: 'pawapay', providerReference: 'dep-1', status: 'paid', env })).toBe(false);
    expect(noSite).toHaveBeenCalledTimes(1);
  });

  it.each([['konektag-fr', 'EUROPE'], ['konektag-cg', 'KONEKTAG_CG'], ['konektag-lb', 'LIBAN']])(
    'follows a recharge of slug %s on its own Network site %s (no country is fixed in the code)', async (slug, site) => {
      const routing = { MARKETPLACE_TRANSACTION_MERCHANTS: JSON.stringify({
        'konektag-fr': { site: 'EUROPE' }, 'konektag-cg': { site: 'KONEKTAG_CG' }, 'konektag-lb': { site: 'LIBAN' } }) } as NodeJS.ProcessEnv;
      const query = vi.fn().mockResolvedValueOnce({ rows: [{ attempt_id: 'a9', provider_reference: 'pi_9', expected_amount: '2500',
        expected_currency: 'EUR', created_at: '2026-11-10T08:00:00Z', order_id: 'o9', slug }] }).mockResolvedValue({ rows: [] });
      expect(await enqueueRechargeOperation({ query }, { provider: 'stripe', providerReference: 'pi_9', status: 'pending', env: routing })).toBe(true);
      expect(JSON.parse(query.mock.calls[1][1][4]).site).toBe(site);
    });

  it('calls the Network site with its service account and requires the acknowledgement', async () => {
    const calls: Array<{ url: string; auth: string; body: any }> = [];
    const ack = (result: unknown, status = 200) => vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), auth: String((init.headers as any).Authorization), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ message: result }), { status });
    });
    await expect(deliverNetworkOperation({ site: 'KONEKTAG_CG', operation }, env, ack({ key: 'recharge:a1', result: 'recorded' }) as any)).resolves.toBe('recorded');
    expect(calls[0]).toEqual({ url: 'https://congo.erp.example/api/method/konektag_360.network_operations.record', auth: 'token k:s', body: { operation } });
    // Anything else is retried by the outbox.
    await expect(deliverNetworkOperation({ site: 'KONEKTAG_CG', operation }, env, ack({ key: 'other', result: 'recorded' }) as any)).rejects.toThrow('NETWORK_OPERATION_NOT_ACKNOWLEDGED');
    await expect(deliverNetworkOperation({ site: 'KONEKTAG_CG', operation }, env, ack({}, 503) as any)).rejects.toThrow('SITE_UNAVAILABLE');
    await expect(deliverNetworkOperation({ site: 'EUROPE', operation }, env, ack({}) as any)).rejects.toThrow('SITE_NOT_CONFIGURED');
    await expect(deliverNetworkOperation({ site: 'KONEKTAG_CG' }, env, ack({}) as any)).rejects.toThrow('NETWORK_OPERATION_PAYLOAD_INVALID');
  });
  it('retires historical Link Pay network projections without contacting ERPNext',async()=>{
    const fetch=vi.fn();
    await expect(deliverNetworkOperation({site:'CONGO',operation:{key:'link-pay:x',eventKey:'link-pay:x:issued',type:'link_pay'}},{},fetch)).resolves.toBe('api_owned');
    expect(fetch).not.toHaveBeenCalled();
  });

});
