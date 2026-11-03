import { describe, expect, it } from 'vitest';
import { LegalDocumentService, LegalDocumentsUnavailableError } from '../../src/application/services/legal-document-service.ts';

const resolver = { resolve: async (detectedCountry: string) => ({ detectedCountry, paymentCountry: 'FR' }) };

describe('LegalDocumentService', () => {
  it('derives stable evidence from the locale catalogues and resolved payment country', async () => {
    const documents = await new LegalDocumentService(resolver as any).active('BE', 'en');

    expect(documents.map((document) => document.id)).toEqual(['FR:terms:1.0', 'FR:privacy:1.0']);
    expect(documents.map((document) => document.version)).toEqual(['1.0', '1.0']);
    expect(documents.every((document) => document.hash.length === 64)).toBe(true);
    expect(documents[0].content).toContain('Terms of Service');
    expect(documents[0].url).toBe('http://localhost:4321/en/legal/terms/');
  });

  it('rejects evidence which is not the current country, locale, version, or snapshot', async () => {
    const service = new LegalDocumentService(resolver as any);
    const documents = await service.active('BE', 'fr');
    await service.assertSelected('BE', 'fr', documents);

    await expect(service.assertSelected('BE', 'fr', [{ ...documents[0], hash: '0'.repeat(64) }, documents[1]]))
      .rejects.toBeInstanceOf(LegalDocumentsUnavailableError);
  });
});
