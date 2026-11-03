import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  download: vi.fn(),
  createWorker: vi.fn(),
  decrypt: vi.fn(),
  project: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { connect: mocks.connect },
}));
vi.mock('../../src/infrastructure/adapters/minio-adapter.ts', () => ({
  minioAdapter: { downloadFromBucket: mocks.download },
}));
vi.mock('tesseract.js', () => ({ createWorker: mocks.createWorker }));
vi.mock('../../src/infrastructure/adapters/encryption-service.ts', () => ({
  encryptionService: { decrypt: mocks.decrypt },
}));
vi.mock('../../src/application/services/erpnext-contact-service.ts', () => ({
  erpnextContactService: { ensure: vi.fn(), project: mocks.project },
}));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts', () => ({
  redisAdapter: { publishKycStatus: mocks.publish },
}));

import { processKycOrder } from '../../src/application/services/kyc-processor.ts';

describe('processKycOrder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'order-1', user_id: 'user-1', status: 'quarantined', id_document_path: 'bad.pdf' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ encrypted_data: 'encrypted', locale: 'fr' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.decrypt.mockReturnValue(JSON.stringify({ firstName: 'Test', lastName: 'User' }));
    mocks.download.mockResolvedValue(Buffer.from('not an image or PDF'));
    mocks.createWorker.mockRejectedValue(new Error('Unsupported image format'));
    mocks.project.mockResolvedValue('CONTACT-1');
    mocks.publish.mockResolvedValue(undefined);
  });


  it('routes OCR name transcription mismatches to manual review without approving or rejecting', async () => {
    mocks.createWorker.mockResolvedValue({
      recognize: vi.fn().mockResolvedValue({data:{text:'Prénom testkdismFkl Nom dfkmtskfl'}}),
      terminate: vi.fn().mockResolvedValue(undefined),
    });
    mocks.decrypt.mockReturnValue(JSON.stringify({firstName:'testkdlsmfkl',lastName:'dfkmlskfl'}));
    await expect(processKycOrder('order-1')).resolves.toBeUndefined();
    const statements=mocks.query.mock.calls.map(([sql])=>String(sql));
    expect(statements.some(sql=>sql.includes("status = 'pending_review'"))).toBe(true);
    expect(statements.some(sql=>sql.includes("status = 'rejected'"))).toBe(false);
    expect(statements.some(sql=>sql.includes("'KycPendingReview'"))).toBe(true);
    const ocrCall=mocks.query.mock.calls.find(([sql])=>String(sql).includes('SET ocr_data ='));
    const ocr=JSON.parse(ocrCall?.[1][0]);
    expect(ocr.reviewRequired).toBe(true);
    expect(ocr.reviewReason).toBe('OCR_IDENTITY_MATCH_UNCERTAIN');
    expect(ocr.lastNameFound).toBe(false);
    expect(ocr.firstNameFound).toBe(false);
    expect(mocks.publish).toHaveBeenLastCalledWith('user-1',expect.objectContaining({status:'pending_review'}));
  });

  it('technically rejects an unreadable upload with audit, an authoritative rejection event, and no worker error', async () => {
    await expect(processKycOrder('order-1')).resolves.toBeUndefined();

    const statements = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("status = 'rejected'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'KycRejected'"))).toBe(true);
    const auditCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO konektag.audit_logs'));
    expect(auditCall?.[1][2]).toBe('KYC_REJECTED_TECHNICAL');
    expect(auditCall?.[1][3]).toContain('DOCUMENT_UNREADABLE');
    expect(auditCall?.[1][3]).not.toContain('not an image');
    // KYC identity is projected asynchronously to Keycloak by the outbox dispatcher.
    // The processor must emit the internal user id, never synchronously call ERP.
    const rejectionEvents = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("'KycRejected'"));
    expect(rejectionEvents).toHaveLength(1);
    expect(rejectionEvents[0][1][1]).toBe('order-1');
    expect(JSON.parse(rejectionEvents[0][1][2])).toEqual({
      userId: 'user-1',
      reason: 'La numérisation du document a échoué. Veuillez soumettre une image plus nette.',
      rejectionCode: 'DOCUMENT_UNREADABLE',
    });
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenLastCalledWith('user-1', expect.objectContaining({ status: 'rejected' }));
    expect(mocks.createWorker).toHaveBeenCalledWith('fra', undefined, expect.objectContaining({ errorHandler: expect.any(Function) }));
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });
});
