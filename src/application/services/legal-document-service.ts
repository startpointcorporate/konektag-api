import crypto from 'node:crypto';
import { getPrivacyContent } from '../catalogs/privacy/catalog.ts';
import { getTermsContent } from '../catalogs/terms/catalog.ts';
import { getSiteUrl } from '../shared/seo.ts';
import type { PaymentCountryResolver } from './pay/payment-country-resolver.ts';

export type LegalDocumentType = 'terms' | 'privacy';

export interface LegalDocumentEvidence {
  id: string;
  type: LegalDocumentType;
  country: string;
  version: string;
  content: string;
  url: string;
  hash: string;
}

export class LegalDocumentsUnavailableError extends Error {}

function versionOf(value: string): string {
  const version = value.match(/\d+(?:\.\d+)+/)?.[0];
  if (!version) throw new LegalDocumentsUnavailableError('Legal document version is missing');
  return version;
}

function evidence(country: string, locale: string | undefined, type: LegalDocumentType): LegalDocumentEvidence {
  const document = type === 'terms' ? getTermsContent(locale) : getPrivacyContent(locale);
  const version = versionOf(document.version);
  const content = JSON.stringify({ title: document.title, sections: document.sections, version: document.version });
  return {
    id: `${country}:${type}:${version}`,
    type,
    country,
    version,
    content,
    url: `${getSiteUrl()}/${locale || 'fr'}/legal/${type}/`,
    hash: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

/** Legal evidence is derived only from the public TypeScript catalogues. */
export class LegalDocumentService {
  constructor(private readonly countryResolver?: PaymentCountryResolver) {}

  async active(detectedCountry: string, locale?: string): Promise<LegalDocumentEvidence[]> {
    const resolver = this.countryResolver ?? (await import('./pay/payment-country-resolver.ts')).paymentCountryResolver;
    const { paymentCountry } = await resolver.resolve(detectedCountry);
    const documents = [
      evidence(paymentCountry, locale, 'terms'),
      evidence(paymentCountry, locale, 'privacy'),
    ];
    if (documents.some((document) => !document.content || !document.url)) {
      throw new LegalDocumentsUnavailableError('No active Terms and Privacy documents');
    }
    return documents;
  }

  async assertSelected(detectedCountry: string, locale: string, selected: LegalDocumentEvidence[]): Promise<void> {
    const active = await this.active(detectedCountry, locale);
    for (const type of ['terms', 'privacy'] as const) {
      const received = selected.find((document) => document.type === type);
      const current = active.find((document) => document.type === type);
      if (!received || !current || received.id !== current.id || received.version !== current.version || received.hash !== current.hash) {
        throw new LegalDocumentsUnavailableError('Selected legal documents are no longer active');
      }
    }
  }
}

export const legalDocumentService = new LegalDocumentService();
