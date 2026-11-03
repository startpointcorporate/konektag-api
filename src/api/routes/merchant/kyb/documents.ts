import type { RouteHandler } from '../../../http';
import { merchantService } from '../../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../../domain/MerchantErrors.ts';
import type { CertificationDocumentType } from '../../../../domain/MerchantProfile.ts';

const VALID_DOC_TYPES: CertificationDocumentType[] = ['business_document', 'manager_identity', 'establishment_photo'];

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const documentType = formData.get('documentType') as string | null;
    if (!(file instanceof File)) return Response.json({ error: 'MISSING_FILE' }, { status: 400 });
    if (!documentType || !VALID_DOC_TYPES.includes(documentType as CertificationDocumentType)) return Response.json({ error: 'INVALID_DOCUMENT_TYPE' }, { status: 400 });
    const doc = await merchantService.uploadKybDocument(user.id, documentType as CertificationDocumentType,
      { buffer: Buffer.from(await file.arrayBuffer()), originalName: file.name, mimeType: file.type }, undefined);
    return Response.json(doc, { status: 201 });
  } catch (error) {
    if (error instanceof MerchantProfileNotFoundError) return Response.json({ error: 'NOT_FOUND', message: error.message }, { status: 404 });
    console.error('[merchant/kyb/documents POST]', error);
    return Response.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
};
