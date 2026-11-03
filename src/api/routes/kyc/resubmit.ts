import type { RouteHandler } from '../../http';
import { kycService } from '../../../application/services/kyc-service.ts';
import { OnboardingError } from '../../../domain/DomainErrors.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const formData = await request.formData();
    const idDoc = formData.get('id_document') as File | null;
    const selfie = formData.get('selfie') as File | null;

    if (!idDoc && !selfie) {
      return new Response(
        JSON.stringify({ error: 'At least one file is required' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }

    let idDocInput;
    let selfieInput;

    if (idDoc) {
      idDocInput = {
        buffer: Buffer.from(await idDoc.arrayBuffer()),
        originalName: idDoc.name,
        mimeType: idDoc.type || 'application/octet-stream',
      };
    }
    if (selfie) {
      selfieInput = {
        buffer: Buffer.from(await selfie.arrayBuffer()),
        originalName: selfie.name,
        mimeType: selfie.type || 'application/octet-stream',
      };
    }

    const order = await kycService.resubmitKyc(user.id, idDocInput, selfieInput);

    return new Response(
      JSON.stringify({ kycOrderId: order.id, status: order.status, attempt: order.attempt }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    if (error instanceof OnboardingError) {
      const humanMessages: Record<string, string> = {
        NO_REJECTED_ORDER: 'Aucun document refusé à soumettre à nouveau.',
      };
      return new Response(
        JSON.stringify({ error: error.code, message: humanMessages[error.code] || error.message }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    console.error('[kyc/resubmit]', error);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
