import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: vi.fn() } }));
import {
  authenticateSite, beneficiaryTerms, LinkPaySiteError, splitAmount, validateRouting,
} from '../../src/application/link-pay/frappe-site-routing.ts';
import { acknowledged, sitePayload } from '../../src/application/link-pay/site-webhook-service.ts';

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const token = 'c'.repeat(40);
const env = {
  LINK_PAY_FRAPPE_SITES: JSON.stringify({
    CONGO: { tokenSha256: sha(token), webhookSecret: 's'.repeat(32), network: true },
    RESTODEMO: { tokenSha256: sha('r'.repeat(40)), webhookSecret: 't'.repeat(32) },
    HOTELDEMO: { tokenSha256: sha('h'.repeat(40)) },
  }),
  MARKETPLACE_FRAPPE_CONGO_URL: 'https://congo.erp.konektag.eu/',
  MARKETPLACE_FRAPPE_RESTODEMO_URL: 'https://restodemo.konektag.eu/',
  MARKETPLACE_FRAPPE_HOTELDEMO_URL: 'https://hoteldemo.konektag.eu/',
} as any;
const auth = (site: string, value: string) => authenticateSite(new Request('http://x', {
  headers: { 'X-Konektag-Frappe-Site': site, 'X-Konektag-Frappe-Token': value } }), env);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return [(e as LinkPaySiteError).code, (e as LinkPaySiteError).missing]; } return null; };

describe('Link Pay network routing', () => {
  it('authenticates a site by its token hash only', () => {
    expect(auth('CONGO', token).key).toBe('CONGO');
    expect(code(() => auth('CONGO', 'x'.repeat(40)))).toEqual(['FRAPPE_SITE_UNAUTHORIZED', []]);
    expect(code(() => auth('NOPE', token))).toEqual(['FRAPPE_SITE_UNAUTHORIZED', []]);
  });

  it('the issuing site is the beneficiary and names an allowlisted network with webhooks configured', () => {
    const congo = auth('CONGO', token);
    expect(validateRouting(congo, 'CONGO', 'CONGO', env)).toEqual({ beneficiarySite: 'CONGO', networkSite: 'CONGO' });
    expect(code(() => validateRouting(congo, undefined, undefined, env))).toEqual(['LINK_PAY_CONTRACT_OUTDATED', ['beneficiarySite', 'networkSite']]);
    expect(code(() => validateRouting(congo, 'RESTODEMO', 'CONGO', env))).toEqual(['BENEFICIARY_SITE_MISMATCH', []]);
    const resto = { key: 'RESTODEMO', config: {} as any };
    expect(code(() => validateRouting(resto, 'RESTODEMO', 'RESTODEMO', env))).toEqual(['NETWORK_SITE_NOT_ALLOWED', []]);
    const hotel = { key: 'HOTELDEMO', config: {} as any };
    expect(code(() => validateRouting(hotel, 'HOTELDEMO', 'CONGO', env)))
      .toEqual(['SITE_WEBHOOK_NOT_CONFIGURED', ['LINK_PAY_FRAPPE_SITES.HOTELDEMO.webhookSecret + MARKETPLACE_FRAPPE_HOTELDEMO_URL']]);
  });

  it('splits the fee half up in minor units, gross = fee + net', () => {
    expect(splitAmount(6500, 250)).toEqual({ gross: 6500, fee: 163, net: 6337 });
    expect(splitAmount(4000, 0)).toEqual({ gross: 4000, fee: 0, net: 4000 });
    expect(splitAmount(199, 250)).toEqual({ gross: 199, fee: 5, net: 194 });
  });

  it('reads the terms on the network site and names each missing term', async () => {
    const terms = (raw: any) => beneficiaryTerms('CONGO', 'RESTODEMO', () => ({ call: async () => raw }) as any)
      .then(() => null, (e: LinkPaySiteError) => [e.code, e.missing]);
    const base = { beneficiary_site: 'RESTODEMO', network_site: 'CONGO', beneficiary_name: 'Resto', enabled: 1, approved: 1,
      approved_by: 'a@b', approved_on: '2026-11-10', terms_hash: 'a'.repeat(64), country: 'CG', fee_mode: 'Percentage',
      fee_rate_bps: 250, payout_ready: 1 };
    expect(await terms(base)).toBeNull();
    expect(await terms({ ...base, enabled: 0, approved: 0 })).toEqual(['BENEFICIARY_NOT_APPROVED', ['enabled', 'collection_approved']]);
    expect(await terms({ ...base, fee_mode: 'Exempt' })).toEqual(['BENEFICIARY_TERMS_INCOMPLETE', ['fee_mode/fee_rate']]);
    expect(await terms({ ...base, country: '', payout_ready: 0 }))
      .toEqual(['BENEFICIARY_TERMS_INCOMPLETE', ['country', 'payout_method + payout details']]);
    expect(await terms({ ...base, network_site: 'OTHER' })).toEqual(['BENEFICIARY_NOT_CONFIGURED', []]);
  });

  it('a delivery counts only when the site acknowledges the transaction for every role', () => {
    const d = { transaction_id: 't1', roles: ['network', 'beneficiary'] };
    expect(acknowledged(d, JSON.stringify({ message: { transactionId: 't1', network: 'recorded', beneficiary: 'Paid' } }))).toBe(true);
    expect(acknowledged(d, JSON.stringify({ message: { transactionId: 't1', network: 'recorded' } }))).toBe(false);
    expect(acknowledged(d, JSON.stringify({ message: { transactionId: 't2', network: 'recorded', beneficiary: 'Paid' } }))).toBe(false);
    expect(acknowledged(d, '<html>')).toBe(false);
  });

  it('the payload carries the split and both sites, never a merchant profile', () => {
    const payload = sitePayload({ id: 't1', k_operation_id: 'k1', paid_at: '2026-11-10T10:00:00Z', currency: 'XAF', quantity_k: 10,
      gross_minor: '6500', fee_minor: '163', net_minor: '6337' }, { invoice: 'INV', invoice_company: 'C', issuer_site: 'RESTODEMO',
      beneficiary_site: 'RESTODEMO', network_site: 'CONGO', beneficiary_name: 'Resto', fee_mode: 'PERCENTAGE', fee_rate_bps: 250 }, 'slug', ['network']);
    expect(payload).toMatchObject({ grossAmount: 6500, feeAmount: 163, netAmount: 6337, thirdParty: true, networkSite: 'CONGO' });
    expect(JSON.stringify(payload)).not.toMatch(/merchant/i);
  });
});
