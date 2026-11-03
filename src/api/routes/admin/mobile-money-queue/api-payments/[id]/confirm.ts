import type { RequestContext } from '../../../../../http';
import type { RouteHandler } from '../../../../../http';
import pool from '../../../../../../infrastructure/database/pool.ts';
import { confirmApiPaymentMobileMoney } from '../../../../../../application/commands/admin/confirm-api-payment-mobile-money-command.ts';
import { MobileMoneyConfirmationError, parseMobileMoneyConfirmation } from '../../../../../../application/commands/admin/mobile-money-confirmation.ts';

async function adminGuard(locals: RequestContext['locals']) {
  if (!locals.user) return null;
  const { rows } = await pool.query<{ role: string }>('SELECT role FROM konektag.users WHERE id = $1', [locals.user.id]);
  return rows[0]?.role === 'admin' ? locals.user : null;
}

export const POST: RouteHandler = async ({ locals, request, params }) => {
  const admin = await adminGuard(locals);
  if (!admin) return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  const orderId = params.id || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
    return new Response(JSON.stringify({ error: 'INVALID_ID' }), { status: 400 });
  }
  try {
    const result = await confirmApiPaymentMobileMoney(orderId, admin.id, parseMobileMoneyConfirmation(await request.json()));
    return new Response(JSON.stringify({ success: true, orderId: result.orderId, idempotent: result.idempotent }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const status = error instanceof MobileMoneyConfirmationError ? error.statusCode : error instanceof SyntaxError ? 400 : 500;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'SERVER_ERROR' }), { status });
  }
};
