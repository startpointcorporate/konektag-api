import type { RouteHandler } from '../../http';
import { kycService } from '../../../application/services/kyc-service.ts';
import { OnboardingError } from '../../../domain/DomainErrors.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  try {
    const formData = await request.formData();
    const idDoc = formData.get('id_document') as File | null;

    if (!idDoc) {
      return new Response(
        JSON.stringify({ error: 'id_document is required', message: 'Veuillez sélectionner un document' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (idDoc.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: 'file_too_large', message: 'Max file size is 10 MB' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowedTypes.includes(idDoc.type) && !idDoc.name.match(/\.(jpg|jpeg|png|pdf)$/i)) {
      return new Response(
        JSON.stringify({ error: 'file_invalid_type', message: 'Allowed: JPG, PNG, PDF' }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const idDocBuffer = Buffer.from(await idDoc.arrayBuffer());

    const order = await kycService.initKyc(
      user.id,
      { buffer: idDocBuffer, originalName: idDoc.name, mimeType: idDoc.type || 'application/octet-stream' },
    );

    return new Response(
      JSON.stringify({ kycOrderId: order.id, status: order.status }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error: unknown) {
    if (error instanceof OnboardingError) {
      return new Response(
        JSON.stringify({ error: error.code, message: error.message }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const message = error instanceof Error ? error.message : 'Erreur serveur';
    console.error('[kyc/init]', message);
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR', message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
