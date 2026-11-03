import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ active: vi.fn() }));
vi.mock('../../src/application/services/legal-document-service.ts', () => ({
  LegalDocumentsUnavailableError: class extends Error {},
  legalDocumentService: { active: mocks.active },
}));

import { GET } from '../../src/api/routes/legal-documents.ts';

describe('GET /api/legal-documents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads documents for the real country and UI locale', async () => {
    mocks.active.mockResolvedValue([{ type: 'terms' }, { type: 'privacy' }]);
    const response = await GET({ url: new URL('http://localhost/api/legal-documents?country=BE&locale=en') } as any);

    expect(response.status).toBe(200);
    expect(mocks.active).toHaveBeenCalledWith('BE', 'en');
  });

  it('fails closed when applicable documents cannot be loaded', async () => {
    mocks.active.mockRejectedValue(new Error('PAYMENT_COUNTRY_MAPPING_NOT_FOUND'));
    const response = await GET({ url: new URL('http://localhost/api/legal-documents?country=ZZ&locale=fr') } as any);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'legal_documents_unavailable' });
  });
});
