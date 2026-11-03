import type { RouteHandler } from '../../../http';
import { merchantService } from '../../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../../domain/MerchantErrors.ts';
import type { CertificationDocumentType } from '../../../../domain/MerchantProfile.ts';

const VALID_DOC_TYPES: CertificationDocumentType[] = ['business_document', 'manager_identity', 'establishment_photo'];

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const documentType = formData.get('documentType') as string | null;
    const title = formData.get('title') as string | null;

    if (!file) return new Response(JSON.stringify({ error: 'MISSING_FILE' }), { status: 400 });
    if (!documentType || !VALID_DOC_TYPES.includes(documentType as CertificationDocumentType)) {
      return new Response(JSON.stringify({ error: 'INVALID_DOCUMENT_TYPE', validTypes: VALID_DOC_TYPES }), { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const doc = await merchantService.uploadKybDocument(
      user.id,
      documentType as CertificationDocumentType,
      { buffer, originalName: file.name, mimeType: file.type },
      title || undefined,
    );

    return new Response(JSON.stringify(doc), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), { status: 404 });
    }
    console.error('[merchant/certification/documents POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
