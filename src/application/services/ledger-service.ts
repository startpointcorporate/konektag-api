import pool from '../../infrastructure/database/pool.ts';
import type { PoolClient } from 'pg';
import { BASE_CURRENCY, convertStatic } from './exchange-rate-service.ts';

export interface LedgerEntry {
  id: string;
  client_id: string;
  entry_type: 'credit' | 'debit';
  amount: number;
  currency: string;
  document_type: string;
  document_ref: string | null;
  description: string | null;
  created_at: string;
  created_by: string | null;
}

export const ledgerService = {
  /**
   * @deprecated Utiliser FinancialTransactionService.execute() pour toute mutation financiere.
   * Cette methode cree des ecritures unilaterales sans transaction double-entree,
   * sans dimensions V3, sans KLot, sans profil reglementaire.
   * Conservee uniquement pour les lectures historiques et les migrations.
   */
  async credit(params: {
    clientId: string;
    amount: number;
    currency?: string;
    documentType: string;
    documentRef: string;
    description?: string;
  }, client?: PoolClient) {
    console.warn('[ledgerService.credit] DEPRECATED — utiliser FinancialTransactionService.execute()');
    const c = client || pool;
    const cur = params.currency || BASE_CURRENCY;
    await c.query(
      `INSERT INTO konektag.ledger_entries
       (client_id, entry_type, entry_side, amount, currency, document_type, document_ref, description)
       VALUES ($1, 'credit', 'credit', $2, $3, $4, $5, $6)`,
      [params.clientId, params.amount, cur, params.documentType, params.documentRef || null, params.description ?? null],
    );
  },

  /**
   * @deprecated Utiliser FinancialTransactionService.execute().
   */
  async debit(params: {
    clientId: string;
    amount: number;
    currency?: string;
    documentType: string;
    documentRef: string;
    description?: string;
  }, client?: PoolClient) {
    console.warn('[ledgerService.debit] DEPRECATED — utiliser FinancialTransactionService.execute()');
    const c = client || pool;
    const cur = params.currency || BASE_CURRENCY;
    await c.query(
      `INSERT INTO konektag.ledger_entries
       (client_id, entry_type, entry_side, amount, currency, document_type, document_ref, description)
       VALUES ($1, 'debit', 'debit', $2, $3, $4, $5, $6)`,
      [params.clientId, params.amount, cur, params.documentType, params.documentRef || null, params.description ?? null],
    );
  },

  async getBalance(clientId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END), 0) AS balance
       FROM konektag.ledger_entries
       WHERE client_id = $1 AND currency = $2`,
      [clientId, BASE_CURRENCY],
    );
    return Number(rows[0]?.balance ?? 0);
  },

  async getBalanceDetail(clientId: string): Promise<{
    credits: number;
    debits: number;
    balance: number;
  }> {
    const { rows } = await pool.query(
      `SELECT currency, entry_type, SUM(amount) AS total
       FROM konektag.ledger_entries
       WHERE client_id = $1
       GROUP BY currency, entry_type`,
      [clientId],
    );
    let credits = 0;
    let debits = 0;
    for (const row of rows) {
      const amt = Number(row.total) || 0;
      const cur = row.currency || BASE_CURRENCY;
      const base = convertStatic(amt, cur, BASE_CURRENCY);
      if (row.entry_type === 'credit') credits += base;
      else debits += base;
    }
    return { credits, debits, balance: credits - debits };
  },

  async getHistory(clientId: string, limit = 20): Promise<LedgerEntry[]> {
    const { rows } = await pool.query(
      `SELECT * FROM konektag.ledger_entries
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [clientId, limit],
    );
    return rows;
  },

  async hasEntriesForDocument(documentRef: string): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM konektag.ledger_entries
       WHERE document_ref = $1
         AND entry_type = 'credit'
         AND document_type = 'Recharge'
         AND (is_reversal = false OR is_reversal IS NULL)
       LIMIT 1`,
      [documentRef],
    );
    return rows.length > 0;
  },
};
