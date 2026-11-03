import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), get: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { connect: mocks.connect } }));
vi.mock('../../src/infrastructure/adapters/erpnext-adapter.ts', () => ({ erpnext: { get: mocks.get } }));

import { frappeMasterDataProjectionService } from '../../src/application/services/frappe-master-data-projection-service.ts';

const legalEntity = {
  entity_code: 'KTG-FR', entity_name: 'Konektag France', company: 'Konektag France',
  country: 'France', currency: 'EUR', status: 'Draft', modified: '2026-08-07 12:00:00',
};
const linkProfile = {
  profile_code: 'LINK-FR-STRIPE', legal_entity: 'KTG-FR', corridor: 'FR-FR', runtime_operation: 'link_payment',
  rail: 'stripe', fund_holder: 'konektag_user', runtime_actor_code: 'STRIPE-FR', min_kyc_level: 'basic',
  runtime_execution_mode: 'provider_confirmation',
  evidence_required: '["payment_intent_id"]', valid_from: '2026-08-07', status: 'Draft', modified: '2026-08-07 12:00:00',
};
const stripeActor = {
  actor_code: 'STRIPE-FR', actor_name: 'Stripe Technology Europe Limited (STEL)', actor_type: 'eme', jurisdiction: 'Ireland',
  license_ref: 'C187865', license_valid_from: '2019-03-22', status: 'Approved', modified: '2026-08-07 12:00:00',
  runtime_technical_provider: 'stripe',
};

describe('Frappe Foundation master-data projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it('projects Draft KTG-FR as non-operational and replays without duplication', async () => {
    mocks.get.mockResolvedValue(legalEntity);
    mocks.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'entity-fr' }] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(frappeMasterDataProjectionService.projectLegalEntity('KTG-FR')).resolves.toEqual({ code: 'KTG-FR', status: 'NOT_CONFIGURED', changed: true });
    expect(mocks.query.mock.calls[1][0]).toContain('INSERT INTO konektag.legal_entities');
    expect(mocks.query.mock.calls[1][1]).toContain('NOT_CONFIGURED');
    expect(mocks.query.mock.calls[2][0]).toContain('count(*)');

    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await expect(frappeMasterDataProjectionService.projectLegalEntity('KTG-FR')).resolves.toMatchObject({ changed: false });
  });

  it('allows only an approved Frappe entity to make runtime KTG-FR operational', async () => {
    mocks.get.mockResolvedValue({ ...legalEntity, status: 'Approved' });
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 'entity-fr' }] }).mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await expect(frappeMasterDataProjectionService.projectLegalEntity('KTG-FR')).resolves.toMatchObject({ status: 'APPROVED' });
    expect(mocks.query.mock.calls[1][1]).toContain('APPROVED');
  });

  it('projects approved STRIPE-FR from Ireland and replays without changing the runtime row', async () => {
    mocks.get.mockResolvedValue(stripeActor);
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 'stripe-fr' }] }).mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await expect(frappeMasterDataProjectionService.projectRegulatedActor('STRIPE-FR')).resolves.toEqual({ code: 'STRIPE-FR', status: 'APPROVED', changed: true });
    expect(mocks.query.mock.calls[1][0]).toContain('INSERT INTO konektag.regulated_actors');
    expect(mocks.query.mock.calls[1][1]).toEqual(expect.arrayContaining([
      'STRIPE-FR', 'Stripe Technology Europe Limited (STEL)', 'eme', 'IE', 'C187865', '2019-03-22', 'stripe', 'APPROVED',
    ]));

    mocks.query.mockReset();
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await expect(frappeMasterDataProjectionService.projectRegulatedActor('STRIPE-FR')).resolves.toMatchObject({ changed: false });
  });

  it('requires licensing evidence before projecting an approved regulated actor', async () => {
    mocks.get.mockResolvedValue({ ...stripeActor, license_ref: undefined, license_valid_from: undefined });

    await expect(frappeMasterDataProjectionService.projectRegulatedActor('STRIPE-FR')).rejects.toThrow('FRAPPE_REGULATED_ACTOR_INVALID');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('fails closed when the runtime legal-entity identity is ambiguous', async () => {
    mocks.get.mockResolvedValue(legalEntity);
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 2 }] }).mockResolvedValueOnce({});

    await expect(frappeMasterDataProjectionService.projectLegalEntity('KTG-FR')).rejects.toThrow('RUNTIME_LEGAL_ENTITY_AMBIGUOUS');
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('master_data_projections');
  });

  it('projects Draft profiles as non-operational and preserves purpose metadata', async () => {
    mocks.get.mockResolvedValue({ ...linkProfile, purpose: 'P04_CARD_ACTIVATION', runtime_actor_code: undefined, rail: 'internal', runtime_operation: 'acquisition', runtime_execution_mode: 'reconciliation' });
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 'entity-fr' }] }).mockResolvedValueOnce({ rows: [{ id: 'profile-fr' }] }).mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await expect(frappeMasterDataProjectionService.projectRegulatoryProfile('LINK-FR-STRIPE')).resolves.toEqual({ code: 'LINK-FR-STRIPE', status: 'DRAFT', changed: true });
    const insert = mocks.query.mock.calls[2];
    expect(insert[0]).toContain('INSERT INTO konektag.regulatory_profiles');
    expect(insert[0]).toContain('FROM konektag.legal_entities le WHERE le.id = $17');
    expect(insert[1]).toContain('DRAFT');
    expect(insert[1]).toContain(JSON.stringify({ purpose: 'P04_CARD_ACTIVATION' }));
    expect(insert[1].at(-1)).toBe('entity-fr');
  });

  it('requires the independent runtime Stripe actor to be approved before an approved profile projects', async () => {
    mocks.get.mockResolvedValue({ ...linkProfile, status: 'Approved' });
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 'entity-fr' }] }).mockResolvedValueOnce({ rows: [{ id: 'stripe-fr', status: 'PENDING_APPROVAL' }] }).mockResolvedValueOnce({});

    await expect(frappeMasterDataProjectionService.projectRegulatoryProfile('LINK-FR-STRIPE')).rejects.toThrow('RUNTIME_REGULATED_ACTOR_NOT_APPROVED');
  });

  it('rejects an ambiguous regulated actor instead of selecting one', async () => {
    mocks.get.mockResolvedValue(linkProfile);
    mocks.query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ id: 'entity-fr' }] }).mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] }).mockResolvedValueOnce({});

    await expect(frappeMasterDataProjectionService.projectRegulatoryProfile('LINK-FR-STRIPE')).rejects.toThrow('RUNTIME_REGULATED_ACTOR_AMBIGUOUS');
  });
});
