import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), verify: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/application/services/operation-currency-service.ts', () => ({ resolveMerchantOperationCurrency: async () => ({ currency: 'XAF' }) }));
vi.mock('../../src/application/services/qr-signed-verification-service.ts', () => ({ verifySignedQrServer: mocks.verify }));
import { qrService } from '../../src/application/services/qr-service.ts';
let kybStatus:string;let merchantStatus:string;
const input = { merchantProfileId: 'merchant-1', userId: 'owner-1', qrType: 'Static' as const, signedToken: 'header.payload.signature' };
describe('merchant QR without ERP', () => {
  beforeEach(() => {
    vi.resetAllMocks();kybStatus='MERCHANT_APPROVED';merchantStatus='Published';
    mocks.verify.mockResolvedValue({ requestId: 'qr-1', beneficiaryType: 'MERCHANT', beneficiaryId: 'merchant-1', currency: 'XAF', variableAmount: true });
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT mm.role') ? [{ role: 'owner' }] : sql.includes('SELECT id FROM') ? [{ id: 'merchant-1' }] : sql.includes('SELECT status, kyb_status') ? [{status:merchantStatus,kyb_status:kybStatus}] : [] }));
  });
  it('T06 generates an eligible merchant QR using the Konektag identity', async () => {
    expect(await qrService.createQR(input)).toMatchObject({ etablissement: 'merchant-1', merchant_profile_id: 'merchant-1', status: 'Active' });
  });
  it('T07 generates while every external HTTP request is unavailable', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Frappe unavailable'));
    try {
      expect((await qrService.createQR(input)).name).toBe('qr-1');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('permits an approved merchant whose visibility profile is still Draft',async()=>{merchantStatus='Draft';expect((await qrService.createQR(input)).status).toBe('Active');});
  it('T08 rejects a nonexistent merchant', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(qrService.createQR(input)).rejects.toThrow('Accès refusé');
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('T09 rejects an unauthorized user before insertion', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(qrService.createQR({ ...input, userId: 'stranger' })).rejects.toThrow('Accès refusé');
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][0]).toContain("mm.role IN ('owner', 'manager')");
  });
  it('requires KYB approval independently of marketplace publication', async () => {
    kybStatus='NOT_STARTED';
    await expect(qrService.createQR(input)).rejects.toThrow('Marchand non active');
  });
});
