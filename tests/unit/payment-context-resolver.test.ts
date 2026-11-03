import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPaymentContextSelection, PaymentContextResolutionError, PaymentContextResolver, verifyPaymentContextSelection } from '../../src/application/services/pay/payment-context-resolver.ts';

const entity = { name: 'KTG-FR', entity_code: 'KTG-FR', entity_name: 'Konektag France', country: 'France', currency: 'EUR', status: 'Approved' };
const stripeProfile = {
  name: 'LINK-FR-STRIPE', profile_code: 'LINK-FR-STRIPE', legal_entity: 'KTG-FR', corridor: 'KTG-FR-KTG-FR',
  runtime_operation: 'link_payment', rail: 'stripe', runtime_provider: 'stripe', provider_configuration_key: 'KTG_FR_STRIPE_TEST', runtime_actor_code: 'STRIPE-FR', status: 'Approved',
  valid_from: '2020-01-01', valid_until: null, fee_percentage_bps: 300, fee_fixed_amount: 0,
};
const corridor = { name: 'KTG-FR-KTG-FR', corridor_code: 'KTG-FR-KTG-FR', origin_entity: 'KTG-FR', destination_entity: 'KTG-FR', status: 'Approved' };
const actor = { name: 'STRIPE-FR', actor_code: 'STRIPE-FR', actor_name: 'Stripe France (PSP)', status: 'Approved' };

function resolver(entities: unknown[], profiles: unknown[], documents: Record<string, unknown> = {}) {
  return new PaymentContextResolver({
    list: async (doctype: string) => doctype === 'Konektag Legal Entity' ? entities as any[] : profiles as any[],
    get: async (doctype: string, name: string) => documents[`${doctype}:${name}`] ?? (doctype === 'Konektag Corridor' ? corridor : actor),
  });
}

describe('PaymentContextResolver', () => {
  const originalSecret = process.env.KONEKTAG_INTEGRATION_SECRET;
  beforeEach(() => { process.env.KONEKTAG_INTEGRATION_SECRET = 'payment-context-selection-secret-123'; });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.KONEKTAG_INTEGRATION_SECRET;
    else process.env.KONEKTAG_INTEGRATION_SECRET = originalSecret;
  });

  it('resolves FR through KTG-FR, the link profile, STRIPE-FR, Stripe and card', async () => {
    await expect(resolver([entity], [stripeProfile]).resolve('fr')).resolves.toEqual({
      country: 'FR', legalEntity: { id: 'KTG-FR', code: 'KTG-FR', legalName: 'Konektag France' }, currency: 'EUR',
      providers: [{
        regulatoryProfile: { id: 'LINK-FR-STRIPE', code: 'LINK-FR-STRIPE', rail: 'stripe' }, corridor: 'KTG-FR-KTG-FR',
        regulatedActor: { id: 'STRIPE-FR', code: 'STRIPE-FR', name: 'Stripe France (PSP)', logoUrl: null },
        provider: 'stripe', providerConfigurationKey: 'KTG_FR_STRIPE_TEST', paymentMethod: 'card', fees: { percentageBps: 300, fixedAmount: 0 },
      }],
    });
  });

  it('signs the resolved selection and rejects a forged provider configuration', () => {
    const token = createPaymentContextSelection({
      country: 'FR', legalEntityCode: 'KTG-FR', currency: 'EUR', regulatoryProfileCode: 'LINK-FR-STRIPE',
      rail: 'stripe', corridor: 'KTG-FR-KTG-FR', regulatedActorCode: 'STRIPE-FR', provider: 'stripe',
      providerConfigurationKey: 'KTG_FR_STRIPE_TEST', paymentMethod: 'card', fees: { percentageBps: 300, fixedAmount: 0 },
    });
    expect(verifyPaymentContextSelection(token)).toMatchObject({ providerConfigurationKey: 'KTG_FR_STRIPE_TEST', paymentMethod: 'card' });
    const [payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), providerConfigurationKey: 'KTG_FR_STRIPE_LIVE' })).toString('base64url');
    expect(() => verifyPaymentContextSelection(`${forgedPayload}.${signature}`)).toThrow('PAYMENT_CONTEXT_SELECTION_INVALID');
  });

  it('fails explicitly for an unknown country, no eligible entity, or ambiguous entities', async () => {
    await expect(resolver([], []).resolve('ZZ')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_LEGAL_ENTITY_NOT_FOUND' });
    await expect(resolver([], []).resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_LEGAL_ENTITY_NOT_FOUND' });
    await expect(resolver([entity, { ...entity, id: 'other' }], []).resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_LEGAL_ENTITY_AMBIGUOUS' });
  });

  it('ignores approved entities without an eligible payment profile', async () => {
    await expect(resolver([entity, { ...entity, name: 'TEST-INBOX-FR', entity_code: 'TEST-INBOX-FR' }], [stripeProfile]).resolve('FR'))
      .resolves.toMatchObject({ legalEntity: { code: 'KTG-FR' } });
  });

  it('fails for no eligible profile, inactive profile, or invalid fees', async () => {
    await expect(resolver([entity], []).resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND' });
    await expect(resolver([entity], [{ ...stripeProfile, valid_until: '2020-01-01' }]).resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND' });
    await expect(resolver([entity], [{ ...stripeProfile, fee_percentage_bps: -1 }]).resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_FEES_INVALID' });
  });

  it('fails closed when an external profile has no approved regulated actor', async () => {
    await expect(resolver([entity], [{ ...stripeProfile, runtime_actor_code: null }]).resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_REGULATED_ACTOR_MISSING' });
    await expect(resolver([entity], [stripeProfile], { 'Konektag Regulated Actor:STRIPE-FR': { ...actor, status: 'Pending Approval' } }).resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_REGULATED_ACTOR_NOT_APPROVED' });
  });

  it('maps external pay rails without routing the independent wallet principal through provider context', async () => {
    const profiles = [
      stripeProfile,
      { ...stripeProfile, name: 'LINK-MM', profile_code: 'LINK-MM', rail: 'mobile_money', runtime_provider: 'pawapay', provider_configuration_key: 'KTG_FR_PAWAPAY_SANDBOX' },
      { ...stripeProfile, name: 'LINK-WALLET', profile_code: 'LINK-WALLET', rail: 'internal', runtime_provider: 'internal', runtime_actor_code: null },
    ];
    const context = await resolver([entity], profiles).resolve('FR');
    expect(context.providers.map(provider => ({
      rail: provider.regulatoryProfile.rail, provider: provider.provider, paymentMethod: provider.paymentMethod,
    }))).toEqual([
      { rail: 'stripe', provider: 'stripe', paymentMethod: 'card' },
      { rail: 'mobile_money', provider: 'pawapay', paymentMethod: 'mobile_money' },
    ]);
  });

  it.each([
    ['CM', 'Cameroon', 'KTG-CM', 'LINK-CM-PAWAPAY'],
    ['CG', 'Congo', 'KTG-CG', 'LINK-CG-PAWAPAY'],
    ['GA', 'Gabon', 'KTG-GA', 'LINK-GA-PAWAPAY'],
  ])('resolves %s to its isolated PawaPay payment context', async (country, countryName, entityCode, profileCode) => {
    const localEntity = { ...entity, name: entityCode, entity_code: entityCode, country: countryName, currency: 'XAF' };
    const profile = { ...stripeProfile, name: profileCode, profile_code: profileCode, legal_entity: entityCode, corridor: `${entityCode}-${entityCode}`, rail: 'mobile_money', runtime_provider: 'pawapay', provider_configuration_key: `KTG_${country}_PAWAPAY_SANDBOX`, runtime_actor_code: `KERRY-${country}` };
    const localCorridor = { ...corridor, name: `${entityCode}-${entityCode}`, corridor_code: `${entityCode}-${entityCode}`, origin_entity: entityCode, destination_entity: entityCode };
    const localActor = { ...actor, name: `KERRY-${country}`, actor_code: `KERRY-${country}` };
    const context = await resolver([localEntity], [profile], { [`Konektag Corridor:${localCorridor.name}`]: localCorridor, [`Konektag Regulated Actor:${localActor.name}`]: localActor }).resolve(country);
    expect(context).toMatchObject({ country, legalEntity: { code: entityCode }, currency: 'XAF', providers: [{ provider: 'pawapay', providerConfigurationKey: `KTG_${country}_PAWAPAY_SANDBOX`, paymentMethod: 'mobile_money', corridor: `${entityCode}-${entityCode}` }] });
  });

  it('returns an explicit error when Frappe is unavailable or the corridor is incoherent', async () => {
    const unavailable = new PaymentContextResolver({ list: async () => { throw new Error('offline'); }, get: async () => ({}) });
    await expect(unavailable.resolve('FR')).rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_FRAPPE_UNAVAILABLE' });
    await expect(resolver([entity], [stripeProfile], { 'Konektag Corridor:KTG-FR-KTG-FR': { ...corridor, status: 'Draft' } }).resolve('FR'))
      .rejects.toMatchObject({ code: 'PAYMENT_CONTEXT_CORRIDOR_INVALID' });
  });
});
