/**
 * Financial Account service — business logic for account balance, history, cashback.
 */
import { ledgerService } from './ledger-service.ts';

export const accountService = {
  /** Get balance from the ledger: sum(credits) − sum(debits). */
  async getBalance(clientId: string) {
    const { credits, debits, balance } = await ledgerService.getBalanceDetail(clientId);
    return {
      balance,
      cashback: 0,
      blocked: 0,
      currency: 'XOF',
    };
  },

  /** Get transaction history from the ledger. */
  async getHistory(clientId: string, limit = 20) {
    const entries = await ledgerService.getHistory(clientId, limit);

    return entries.map(e => {
      const typeMap: Record<string, string> = {
        Recharge: 'recharge',
        KSend: 'k_send',
        KSendReceived: 'k_send_received',
        PaymentSent: 'qr_payment',
        PaymentReceived: 'payment_received',
        Fees: 'fees',
        Cashback: 'cashback',
      };

      return {
        id: e.id,
        type: typeMap[e.document_type] || e.document_type,
        ref: e.document_ref,
        description: e.description || '',
        amount: e.entry_type === 'debit' ? -(e.amount || 0) : (e.amount || 0),
        status: 'Complété',
        date: e.created_at,
      };
    });
  },

  /** Get cashback summary from the ledger. */
  async getCashback(clientId: string) {
    const { rows } = await (await import('../../infrastructure/database/pool.ts')).default.query(
      `SELECT amount, created_at, document_ref FROM konektag.ledger_entries
       WHERE client_id = $1 AND document_type = 'Cashback'
       ORDER BY created_at DESC LIMIT 100`,
      [clientId],
    );
    const total = rows.reduce((sum: number, r: any) => sum + (r.amount || 0), 0);
    return {
      available: total,
      pending: 0,
      totalEarned: total,
      history: rows.map((r: any) => ({
        amount: r.amount,
        date: r.created_at,
        status: 'available' as const,
        source: r.document_ref,
      })),
    };
  },
};
