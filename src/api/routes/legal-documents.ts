import type { RouteHandler } from '../http';
import { legalDocumentService, LegalDocumentsUnavailableError } from '../../application/services/legal-document-service.ts';

export const GET: RouteHandler = async ({ url }) => {
  const country = url.searchParams.get('country')?.trim().toUpperCase();
  const locale = url.searchParams.get('locale')?.trim();
  if (!country || !/^[A-Z]{2}$/.test(country)) return new Response(JSON.stringify({ error: 'legal_country_required' }), { status: 422 });
  try {
    return new Response(JSON.stringify({ documents: await legalDocumentService.active(country, locale) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) {
    const message = error instanceof LegalDocumentsUnavailableError ? error.message : 'Legal documents unavailable';
    return new Response(JSON.stringify({ error: 'legal_documents_unavailable', message }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
};
