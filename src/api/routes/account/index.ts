import type { RouteHandler } from '../../http';
import { accountService } from '../../../application/services/account-service.ts';

/** GET /api/account — get balance + recent history */
export const GET: RouteHandler = async ({ url, locals }) => {
  const user = (locals as any).user;
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  try {
    const section = url.searchParams.get('section') || 'overview';

    switch (section) {
      case 'balance': {
        const balance = await accountService.getBalance(user.id);
        return new Response(JSON.stringify(balance), { headers: { 'Content-Type': 'application/json' } });
      }
      case 'history': {
        const limit = parseInt(url.searchParams.get('limit') || '20');
        const history = await accountService.getHistory(user.id, limit);
        return new Response(JSON.stringify(history), { headers: { 'Content-Type': 'application/json' } });
      }
      case 'cashback': {
        const cashback = await accountService.getCashback(user.id);
        return new Response(JSON.stringify(cashback), { headers: { 'Content-Type': 'application/json' } });
      }
      default: {
        const [balance, history, cashback] = await Promise.all([
          accountService.getBalance(user.id),
          accountService.getHistory(user.id, 5),
          accountService.getCashback(user.id),
        ]);
        return new Response(JSON.stringify({ balance, history, cashback }), { headers: { 'Content-Type': 'application/json' } });
      }
    }
  } catch (err: any) {
    console.error('[api/account] GET error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
