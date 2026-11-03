import type { RouteHandler } from '../../http';
import { contactService } from '../../../application/services/contact-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { slug, senderName, senderEmail, senderPhone, message } = body;

    if (!slug || !senderName || !senderEmail || !message) {
      return new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'slug, senderName, senderEmail et message requis' }), { status: 400 });
    }

    const result = await contactService.sendMessage(slug, senderName, senderEmail, message, senderPhone, locals.user?.id);

    return new Response(JSON.stringify({ success: true, messageId: result.id }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[merchant/contact]', error);
    return new Response(JSON.stringify({ error: 'CONTACT_ERROR', message: error.message }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
