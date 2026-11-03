import type { RouteHandler } from '../../http';
import { notificationService } from '../../../application/services/notification-service.ts';

export const POST: RouteHandler = async ({ locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  const userId = user.keycloak_id || user.id;

  try {
    await notificationService.markAllAsRead(userId);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
