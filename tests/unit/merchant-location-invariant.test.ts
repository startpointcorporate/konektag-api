import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  uploadQrCode: vi.fn(async () => ({ url: 'https://cdn.example.com/qr.png' })),
  generateQrCodeDataUrl: vi.fn(async (_value: string) => 'data:image/png;base64,x'),
  generateQrCodeBuffer: vi.fn(async (_value: string) => Buffer.from('x')),
  setActivityPublication: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.query, connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.release })) },
}));
vi.mock('../../src/infrastructure/media-storage.ts', () => ({
  merchantMediaStorage: { uploadQrCode: mocks.uploadQrCode, uploadMedia: vi.fn() },
}));
vi.mock('../../src/application/qrcode-service.ts', () => ({
  qrcodeService: { generateQrCodeDataUrl: mocks.generateQrCodeDataUrl, generateQrCodeBuffer: mocks.generateQrCodeBuffer },
}));
vi.mock('../../src/application/merchant-activity-profile.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/application/merchant-activity-profile.ts')>()),
  setActivityPublication: mocks.setActivityPublication,
}));
vi.mock('../../src/infrastructure/correlation-id.ts', () => ({ getCorrelationId: () => 'corr-test' }));

import { merchantService } from '../../src/application/merchant-service.ts';
import { MerchantLocationRequiredError } from '../../src/domain/MerchantErrors.ts';
import { requireMerchantLocation } from '../../src/domain/MerchantLocation.ts';
import { marketplaceActivityPath, marketplaceMerchantPath } from '../../src/application/shared/marketplace/slug.ts';

const located = { id: 'mp-1', user_id: 'u-1', slug: 'chez-amina', business_name: 'Chez Amina', city: 'Yaoundé', country: 'CM', locale: 'fr' };
const missingLocations = [
  ['without city', { city: null, country: 'CM' }, ['city']],
  ['without country', { city: 'Yaoundé', country: null }, ['country']],
  ['with a blank city', { city: '   ', country: 'CM' }, ['city']],
  ['with a blank country', { city: 'Yaoundé', country: '' }, ['country']],
] as const;

function sqlCalls(): string[] {
  return mocks.query.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('merchant location invariant — domain', () => {
  it.each(missingLocations)('rejects a location %s', (_, location, missing) => {
    expect(() => requireMerchantLocation(location)).toThrow(MerchantLocationRequiredError);
    try { requireMerchantLocation(location); } catch (error) {
      expect((error as MerchantLocationRequiredError).missing).toEqual(missing);
    }
  });

  it('returns a trimmed location', () => {
    expect(requireMerchantLocation({ city: ' Douala ', country: ' CM ' })).toEqual({ city: 'Douala', country: 'CM' });
  });
});

describe('merchant location invariant — creation', () => {
  it.each(missingLocations)('rejects creation %s before any write', async (_, location) => {
    await expect(merchantService.createProfile('u-1', { businessName: 'Chez Amina', ...location } as never))
      .rejects.toBeInstanceOf(MerchantLocationRequiredError);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it('persists the trimmed location of a valid merchant', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }); // slug uniqueness
    mocks.query.mockResolvedValue({rows:[{...located,id:'mp-new',city:'Douala',country:'CM'}]});
    mocks.clientQuery.mockResolvedValue({ rows: [{ id: 'mp-new', slug: 'chez-amina' }] });

    await merchantService.createProfile('u-1', { businessName: 'Chez Amina', city: ' Douala ', country: ' CM ' });

    const insert = mocks.clientQuery.mock.calls.find((call) => String(call[0]).includes('INSERT INTO konektag.merchant_profiles'))!;
    expect(insert[1]).toEqual(expect.arrayContaining(['Douala', 'CM']));
  });
});

describe('merchant location invariant — update', () => {
  it.each([
    ['clearing the city', { city: null }],
    ['blanking the city', { city: '  ' }],
    ['clearing the country', { country: null }],
    ['blanking the country', { country: '' }],
  ] as const)('rejects %s without writing', async (_, change) => {
    mocks.query.mockResolvedValueOnce({ rows: [located] }); // resolveProfile

    await expect(merchantService.updateProfile('u-1', change as never)).rejects.toBeInstanceOf(MerchantLocationRequiredError);
    expect(sqlCalls().some((sql) => sql.startsWith('UPDATE'))).toBe(false);
  });

  it('accepts a location change and stores trimmed values', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [located] }); // resolveProfile
    mocks.query.mockResolvedValue({ rows: [located] });

    await merchantService.updateProfile('u-1', { city: ' Douala ' });

    const update = mocks.query.mock.calls.find((call) => String(call[0]).startsWith('UPDATE konektag.merchant_profiles SET'))!;
    expect(update[0]).toContain('city = $1');
    expect(update[1]).toEqual(['Douala', 'mp-1']);
  });
});

describe('merchant location invariant — publication', () => {
  it.each(missingLocations)('rejects N2 publication %s before any snapshot', async (_, location) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...located, ...location }] }); // resolveProfile
    mocks.query.mockResolvedValueOnce({ rows: [{ allowed: 1 }] }); // requireOwnerOrManager

    await expect(merchantService.publishEstablishment('u-1')).rejects.toBeInstanceOf(MerchantLocationRequiredError);
    expect(sqlCalls().some((sql) => sql.includes('merchant_n2_publication_snapshots'))).toBe(false);
  });

  it.each(missingLocations)('rejects N3 publication %s before changing activity state', async (_, location) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...located, ...location }] }); // resolveProfile
    mocks.query.mockResolvedValueOnce({ rows: [{ allowed: 1 }] }); // requireOwnerOrManager

    await expect(merchantService.publishProfile('u-1', 'Restaurant')).rejects.toBeInstanceOf(MerchantLocationRequiredError);
    expect(mocks.setActivityPublication).not.toHaveBeenCalled();
    expect(sqlCalls().some((sql) => sql.includes('merchant_publication_snapshots'))).toBe(false);
    expect(mocks.uploadQrCode).not.toHaveBeenCalled();
  });

  it('publishes N3 with the canonical N2 page URL and QR of a valid merchant', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [located] }); // resolveProfile
    mocks.query.mockResolvedValueOnce({ rows: [{ allowed: 1 }] }); // requireOwnerOrManager
    mocks.query.mockResolvedValue({ rows: [located] });

    mocks.clientQuery.mockImplementation((...args)=>mocks.query(...args));
    await merchantService.publishProfile('u-1', 'Restaurant');

    expect(mocks.generateQrCodeBuffer).toHaveBeenCalledWith('https://konektag.io/fr/marketplace/yaounde/chez-amina/');
    const update = mocks.query.mock.calls.find((call) => String(call[0]).includes('SET qr_code_url = $1, public_page_url = $2'))!;
    expect(update[1]).toEqual(['https://cdn.example.com/qr.png', '/fr/marketplace/yaounde/chez-amina/', 'mp-1']);
  });
});

describe('merchant location invariant — Marketplace QR', () => {
  it.each(missingLocations)('refuses to generate a permanent Marketplace QR %s', async (_, location) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...located, ...location }] }); // resolveProfile

    await expect(merchantService.generatePermanentQrCode('u-1')).rejects.toBeInstanceOf(MerchantLocationRequiredError);
    expect(mocks.generateQrCodeBuffer).not.toHaveBeenCalled();
    expect(mocks.uploadQrCode).not.toHaveBeenCalled();
    expect(sqlCalls().some((sql) => sql.includes('qr_code_url'))).toBe(false);
  });

  it('never persists a stored public URL that lacks its city segment', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ...located, public_page_url: '/fr/marketplace//chez-amina/' }] })
      .mockResolvedValueOnce({ rows: [{ locale: 'fr' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(merchantService.generatePermanentQrCode('u-1')).resolves.toEqual({
      qrCodeUrl: 'https://cdn.example.com/qr.png',
      publicPageUrl: '/fr/marketplace/yaounde/chez-amina/',
    });
  });

  it('does not build a Marketplace QR without location and keeps the payment QR for an approved merchant', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...located, city: null,kyb_status:'MERCHANT_APPROVED' }] }); // resolveProfile
    mocks.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM konektag.merchant_profiles WHERE id') ? [{ ...located, city: null,kyb_status:'MERCHANT_APPROVED' }]
        : sql.includes('SELECT locale') ? [{ locale: 'fr' }] : [],
    }));

    const profile = await merchantService.getProfile('u-1');

    const encoded = mocks.generateQrCodeDataUrl.mock.calls.map((call) => String(call[0]));
    expect(encoded.some((value) => value.includes('/marketplace/'))).toBe(false);
    expect(encoded).toHaveLength(1);
    expect(JSON.parse(encoded[0])).toMatchObject({ type: 'qr_payment', reference: 'chez-amina' });
    expect(profile.publicPageUrl).toBeUndefined();
  });
});

describe('merchant location invariant — claim', () => {
  it('rejects a claim request on a referenced establishment without location', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...located, user_id: null, status: 'Referenced', city: '' }] });

    await expect(merchantService.claimProfile('u-2', 'chez-amina')).rejects.toBeInstanceOf(MerchantLocationRequiredError);
    expect(sqlCalls().some((sql) => sql.includes('INSERT INTO konektag.merchant_claims'))).toBe(false);
  });

  it('rolls back a claim approval when the establishment has no location', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'claim-1', merchant_profile_id: 'mp-1', user_id: 'u-2' }] });
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('SELECT city, country') ? [{ city: 'Yaoundé', country: null }] : [],
    }));

    await expect(merchantService.approveClaim('claim-1', 'admin-1')).rejects.toBeInstanceOf(MerchantLocationRequiredError);
    const statements = mocks.clientQuery.mock.calls.map((call) => String(call[0]));
    expect(statements).toContain('ROLLBACK');
    expect(statements.some((sql) => sql.includes('merchant_memberships'))).toBe(false);
  });
});

describe('merchant location invariant — canonical Marketplace URLs', () => {
  it('builds the canonical N2 and N3 URLs of a valid merchant', () => {
    expect(marketplaceMerchantPath('fr', 'Yaoundé', 'chez-amina')).toBe('/fr/marketplace/yaounde/chez-amina/');
    expect(marketplaceActivityPath('fr', 'Saint-Étienne', 'Restaurant', 'chez-amina'))
      .toBe('/fr/marketplace/saint-etienne/Restaurant/chez-amina/');
  });

  it.each([null, undefined, '', '   ', '!!!'])('never builds a URL with an empty city segment (%j)', (city) => {
    expect(() => marketplaceMerchantPath('fr', city, 'chez-amina')).toThrow(MerchantLocationRequiredError);
    expect(() => marketplaceActivityPath('fr', city, 'Hotel', 'chez-amina')).toThrow(MerchantLocationRequiredError);
  });
});
