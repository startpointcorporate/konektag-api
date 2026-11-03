import type { RouteHandler } from '../../../http';
import { merchantService } from '../../../../application/merchant-service.ts';
import {
  MerchantProfileNotFoundError,
  MerchantCertificationIncompleteError,
  MerchantAlreadyCertifiedError,
} from '../../../../domain/MerchantErrors.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const dossier = await merchantService.getCertificationDossier(user.id);
    return new Response(JSON.stringify(dossier), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), { status: 404 });
    }
    console.error('[merchant/certification GET]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const body = await request.json();
    const { action } = body;

    if (action === 'submit') {
      const dossier = await merchantService.submitKyb(user.id);
      return new Response(JSON.stringify(dossier), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'INVALID_ACTION' }), { status: 400 });
  } catch (error: any) {
    if (error instanceof MerchantCertificationIncompleteError) {
      return new Response(JSON.stringify({ error: 'INCOMPLETE', message: error.message }), { status: 422 });
    }
    if (error instanceof MerchantAlreadyCertifiedError) {
      return new Response(JSON.stringify({ error: 'ALREADY_CERTIFIED', message: error.message }), { status: 409 });
    }
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), { status: 404 });
    }
    console.error('[merchant/certification POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
