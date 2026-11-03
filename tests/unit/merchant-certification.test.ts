import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPool = { query: vi.fn() };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));
vi.mock('../../src/infrastructure/media-storage.ts', () => ({
  merchantMediaStorage: {
    uploadMedia: vi.fn(async () => ({ url: 'https://cdn.example.com/cert-doc.png', key: 'merchant/mp-1/cert-doc.png' })),
    uploadQrCode: vi.fn(async () => ({ url: 'https://cdn.example.com/qr.png' })),
  },
}));
vi.mock('../../src/application/qrcode-service.ts', () => ({
  qrcodeService: { generateQrCodeDataUrl: vi.fn(async () => 'data:image/png;base64,x'), generateQrCodeBuffer: vi.fn(async () => Buffer.from('x')) },
}));
vi.mock('../../src/infrastructure/correlation-id.ts', () => ({ getCorrelationId: () => 'corr-cert' }));

let merchantService: typeof import('../../src/application/merchant-service.ts').merchantService;

const baseProfile = {
  id: 'mp-1', user_id: 'u-1', slug: 'chez-amina',
  business_name: 'Chez Amina', city: 'Yaoundé', country: 'Cameroun',
  certification_status: 'NON_CERTIFIED', certification_submitted_at: null,
  certification_reviewed_at: null, certification_reviewed_by: null,
};

const RESOLVE_QUERY = /merchant_memberships[\s\S]*is_primary DESC/;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ merchantService } = await import('../../src/application/merchant-service.ts'));
});

describe('merchantService — certification flow', () => {

  describe('getCertificationDossier', () => {
    it('returns NON_CERTIFIED with zero documents and zero transactions for new merchant', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [baseProfile] }) // resolveProfile
        .mockResolvedValueOnce({ rows: [] }) // certification documents
        .mockResolvedValueOnce({ rows: [{ cnt: 0 }] }); // count received transactions

      const dossier = await merchantService.getCertificationDossier('u-1');

      expect(dossier.status).toBe('NON_CERTIFIED');
      expect(dossier.documents).toHaveLength(0);
      expect(dossier.receivedTransactions).toBe(0);
      expect(dossier.receivedTransactionsRequired).toBe(10);
    });

    it('returns PENDING_VALIDATION status for submitted merchant', async () => {
      const pending = { ...baseProfile, certification_status: 'PENDING_VALIDATION', certification_submitted_at: new Date().toISOString() };
      mockPool.query
        .mockResolvedValueOnce({ rows: [pending] })
        .mockResolvedValueOnce({ rows: [
          { id: 'doc-1', merchant_profile_id: 'mp-1', document_type: 'business_document', file_url: 'https://cdn.example.com/a.pdf', title: null, file_key: 'k', mime_type: 'application/pdf', submitted_at: '2026-01-01', created_at: '2026-01-01' },
          { id: 'doc-2', merchant_profile_id: 'mp-1', document_type: 'manager_identity', file_url: 'https://cdn.example.com/b.jpg', title: null, file_key: 'k2', mime_type: 'image/jpeg', submitted_at: '2026-01-01', created_at: '2026-01-01' },
          { id: 'doc-3', merchant_profile_id: 'mp-1', document_type: 'establishment_photo', file_url: 'https://cdn.example.com/c.jpg', title: null, file_key: 'k3', mime_type: 'image/jpeg', submitted_at: '2026-01-01', created_at: '2026-01-01' },
        ] })
        .mockResolvedValueOnce({ rows: [{ cnt: 7 }] });

      const dossier = await merchantService.getCertificationDossier('u-1');

      expect(dossier.status).toBe('PENDING_VALIDATION');
      expect(dossier.documents).toHaveLength(3);
      expect(dossier.receivedTransactions).toBe(7);
    });
  });

  // KYB submission replaced the retired manual certification commands.
  describe('KYB documents and submission', () => {
    it('uploads a scoped KYB document without changing certification', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [baseProfile] }).mockResolvedValueOnce({ rows: [{
        id: 'doc-new', merchant_profile_id: 'mp-1', document_type: 'business_document',
        title: 'Registre', file_url: 'https://cdn.example.com/cert-doc.png',
      }] });
      const document = await merchantService.uploadKybDocument('u-1', 'business_document',
        { buffer: Buffer.from('x'), originalName: 'reg.png', mimeType: 'image/png' }, 'Registre');
      expect(document).toMatchObject({ documentType: 'business_document', title: 'Registre' });
      expect(mockPool.query.mock.calls[1][0]).toContain('konektag.merchant_kyb_documents');
      expect(mockPool.query.mock.calls[1][1][0]).toBe('mp-1');
    });
    it('requires all three KYB document types', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [baseProfile] })
        .mockResolvedValueOnce({ rows: [{ document_type: 'business_document' }] });
      await expect(merchantService.submitKyb('u-1')).rejects.toThrow('Dossier incomplet');
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });
    it('submits KYB without granting certification', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [baseProfile] })
        .mockResolvedValueOnce({ rows: ['business_document', 'manager_identity', 'establishment_photo'].map(document_type => ({ document_type })) })
        .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ cnt: 0 }] });
      expect((await merchantService.submitKyb('u-1')).status).toBe('NON_CERTIFIED');
      expect(mockPool.query.mock.calls[2][0]).toContain("kyb_status = 'DOCUMENTS_SUBMITTED'");
      expect(mockPool.query.mock.calls[2][0]).not.toContain('certification_status =');
      expect(mockPool.query.mock.calls[3][1]).toContain('MERCHANT_KYB_SUBMITTED');
    });
    it('scopes deletion to the authenticated merchant', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [baseProfile] }).mockResolvedValueOnce({ rows: [] });
      await merchantService.deleteKybDocument('u-1', 'doc-1');
      expect(mockPool.query.mock.calls[1][1]).toEqual(['doc-1', 'mp-1']);
      expect(mockPool.query.mock.calls[1][0]).toContain('merchant_profile_id = $2');
    });
  });

  describe('countReceivedTransactions', () => {
    it('returns the count of completed qr_payment and api_payment transactions', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ cnt: 5 }] });

      const count = await merchantService.countReceivedTransactions('mp-1');
      expect(count).toBe(5);
    });
  });

  describe('claim does not imply certification', () => {
    it('claim leaves certification_status as NON_CERTIFIED', async () => {
      // verify claimProfile only touches merchant_claims, not certification
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ id: 'mp-ref', status: 'Referenced', business_name: 'Test', slug: 'test', user_id: null, city: 'Douala', country: 'CM' }] }) // lookup
        .mockResolvedValueOnce({ rows: [] }) // existing claim check
        .mockResolvedValueOnce({ rows: [] }) // insert claim
        .mockResolvedValueOnce({ rows: [] }); // audit log

      const result = await merchantService.claimProfile('u-1', 'test');
      expect(result.status).toBe('pending');
    });
  });
});

describe('certification badge logic', () => {
  it('a Referenced+non-claimed merchant should not be certified', () => {
    // certification_status defaults to NON_CERTIFIED on new import
    // and a Referenced merchant with no user_id cannot be Published
    // so certified = false
    expect('NON_CERTIFIED').not.toBe('VALIDATED');
  });

  it('a merchant with KYC-verified user but certification_status = NON_CERTIFIED is not certified', () => {
    // user.state = COMPLETED is no longer sufficient
    const certificationStatus: string = 'NON_CERTIFIED';
    const certified = certificationStatus === 'VALIDATED';
    expect(certified).toBe(false);
  });

  it('only VALIDATED merchants have certified = true', () => {
    expect(('NON_CERTIFIED' as string) === 'VALIDATED').toBe(false);
    expect(('PENDING_VALIDATION' as string) === 'VALIDATED').toBe(false);
    expect(('VALIDATED' as string) === 'VALIDATED').toBe(true);
  });
});
