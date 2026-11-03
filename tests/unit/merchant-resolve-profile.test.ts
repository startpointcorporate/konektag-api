import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn(), connect: vi.fn(async()=>({query:vi.fn(async()=>({rowCount:1,rows:[]})),release:vi.fn()})) };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));
vi.mock('../../src/infrastructure/media-storage.ts', () => ({
  merchantMediaStorage: {
    uploadMedia: vi.fn(async () => ({ url: 'https://cdn.example.com/m.png' })),
    uploadQrCode: vi.fn(async () => ({ url: 'https://cdn.example.com/qr.png' })),
  },
}));
vi.mock('../../src/application/qrcode-service.ts', () => ({
  qrcodeService: { generateQrCodeDataUrl: vi.fn(async () => 'data:image/png;base64,x'), generateQrCodeBuffer: vi.fn(async () => Buffer.from('x')) },
}));
vi.mock('../../src/application/services/merchant-activation-service.ts', () => ({ merchantActivationService: { requireMerchantApproved: vi.fn(async () => ({ ok: true })) } }));
vi.mock('../../src/infrastructure/correlation-id.ts', () => ({ getCorrelationId: () => 'corr-test' }));

let merchantService: typeof import('../../src/application/merchant-service.ts').merchantService;

const CANONICAL_RESOLUTION = /merchant_memberships[\s\S]*is_primary DESC, mp\.created_at DESC LIMIT 1/;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ merchantService } = await import('../../src/application/merchant-service.ts'));
});

describe('merchantService — résolution de profil unique (comptes multi-fiches)', () => {
  const profile = { id: 'mp-1', user_id: 'u-1', slug: 'chez-amina', business_name: 'Chez Amina' };

  it('getProfile utilise la résolution canonique', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [profile] }); // resolveProfile
    mockPool.query.mockResolvedValue({ rows: [profile] }); // loadFullProfile + relations

    await merchantService.getProfile('u-1');

    expect(mockPool.query.mock.calls[0][0]).toMatch(CANONICAL_RESOLUTION);
  });

  it('uploadMedia vérifie le rôle puis le profil explicitement sélectionné', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ allowed: 1 }] }); // active owner/manager
    mockPool.query.mockResolvedValueOnce({ rows: [profile] }); // explicit profile
    mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: '0' }] }); // count médias
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'media-1' }] }); // INSERT media
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE cover

    await merchantService.uploadMedia('u-1', 'mp-1', { buffer: Buffer.from([137,80,78,71,13,10,26,10]), originalName: 'a.png', mimeType: 'image/png' });

    expect(mockPool.query.mock.calls[0][0]).toContain("mm.role IN ('owner', 'manager')");
    expect(mockPool.query.mock.calls[0][1]).toEqual(['mp-1', 'u-1']);
    expect(mockPool.query.mock.calls[1][1]).toEqual(['mp-1']);
  });

  it('saveExternalLinks utilise la même résolution canonique', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [profile] }); // resolveProfile
    mockPool.query.mockResolvedValue({ rows: [] }); // DELETE + INSERT

    await merchantService.saveExternalLinks('u-1', [{ label: 'Site', url: 'https://example.com', linkType: 'Website', displayOrder: 0 }]);

    expect(mockPool.query.mock.calls[0][0]).toMatch(CANONICAL_RESOLUTION);
  });

  it('saveOpeningHours utilise la même résolution canonique', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [profile] }); // resolveProfile
    mockPool.query.mockResolvedValue({ rows: [{ allowed: 1 }] }); // owner/manager authorization

    await merchantService.saveOpeningHours('u-1', [{ dayOfWeek: 1, openTime: '09:00', closeTime: '18:00', isClosed: false }]);

    expect(mockPool.query.mock.calls[0][0]).toMatch(CANONICAL_RESOLUTION);
  });

  it.each([null, 'Restaurant'] as const)('saveOpeningHours rejette les jours dupliqués sans transaction SQL (scope %s)', async (scope) => {
    await expect(merchantService.saveOpeningHours('u-1', [
      { dayOfWeek: 6, isClosed: false, openTime: '09:00', closeTime: '18:00' },
      { dayOfWeek: 6, isClosed: true },
    ], scope)).rejects.toThrow('DUPLICATE_OPENING_HOURS_DAY');

    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('publishProfile utilise la même résolution canonique', async () => {
    const full = { ...profile, city: 'Yaoundé', country: 'CM', short_description: 'x', phone: '+237', locale: 'fr' };
    mockPool.query.mockResolvedValueOnce({ rows: [full] }); // resolveProfile
    mockPool.query.mockResolvedValue({ rows: [full] }); // UPDATE, locale, QR, audit, loadFullProfile

    mockPool.connect.mockResolvedValueOnce({query:mockPool.query,release:vi.fn()});
    await merchantService.publishProfile('u-1', 'Restaurant');

    expect(mockPool.query.mock.calls[0][0]).toMatch(CANONICAL_RESOLUTION);
  });

  it('resolveProfile lève MerchantProfileNotFoundError sans fiche', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(merchantService.getProfile('u-404')).rejects.toThrow();
  });

  it('liste les demandes d\'affectation à suivre séparément des commerces gérés', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'claim-1', status: 'pending', created_at: '2026-07-24T10:00:00.000Z', reviewed_at: null,
        business_name: 'Restaurant Référencé', slug: 'restaurant-reference', city: 'Yaoundé', country: 'Cameroun',
      }],
    });

    await expect(merchantService.getAssignmentRequestsByUserId('u-1')).resolves.toEqual([{
      id: 'claim-1', status: 'pending', createdAt: '2026-07-24T10:00:00.000Z', reviewedAt: null,
      businessName: 'Restaurant Référencé', slug: 'restaurant-reference', city: 'Yaoundé', country: 'Cameroun',
    }]);
    expect(mockPool.query.mock.calls[0][0]).toContain("c.status IN ('pending', 'rejected')");
  });

  it('génère un QR permanent pour une fiche déjà publiée sans QR existant', async () => {
    // Merchant location invariant: the permanent QR targets the canonical N2 URL, city included.
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ ...profile, city: 'Yaoundé', country: 'CM' }] }) // resolveProfile
      .mockResolvedValueOnce({ rows: [{ locale: 'fr' }] }) // locale
      .mockResolvedValueOnce({ rows: [] }); // update profile

    await expect(merchantService.generatePermanentQrCode('u-1')).resolves.toEqual({
      qrCodeUrl: 'https://cdn.example.com/qr.png',
      publicPageUrl: '/fr/marketplace/yaounde/chez-amina/',
    });
  });
});

describe('merchantService — authorisation exacte de membership', () => {
  it.each(['owner', 'manager'])('allows an active %s for the requested merchant only', async (role) => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ allowed: 1 }] });

    await expect(merchantService.requireOwnerOrManager('merchant-1', 'actor-1')).resolves.toBeUndefined();
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("mm.role IN ('owner', 'manager')"), ['merchant-1', 'actor-1']);
  });

  it('denies a cross-merchant actor', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(merchantService.requireOwnerOrManager('merchant-2', 'actor-1')).rejects.toThrow();
  });

  it('denies an actor without an active membership', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(merchantService.requireOwnerOrManager('merchant-1', 'unaffiliated-1')).rejects.toThrow();
  });
});
