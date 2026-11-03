import type { RouteHandler } from '../../http';
import { contactService } from '../../../application/services/contact-service.ts';

export const GET: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ messages: [], total: 0, unreadCount: 0 }), { status: 401 });

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '20');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  try {
    const result = await contactService.getMessages(user.id, limit, offset);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[merchant/messages]', err);
    return new Response(JSON.stringify({ messages: [], total: 0, unreadCount: 0 }), { status: 200 });
  }
};

export const PUT: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  const url = new URL(request.url);
  const messageId = url.searchParams.get('id');
  if (!messageId) return new Response(JSON.stringify({ error: 'BAD_REQUEST' }), { status: 400 });

  try {
    await contactService.markAsRead(messageId);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[merchant/messages PUT]', err);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
