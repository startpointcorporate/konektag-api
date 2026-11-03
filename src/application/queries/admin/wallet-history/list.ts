import pool from '../../../../infrastructure/database/pool.ts';

export interface WalletHistoryListParams {
  page: number;
  pageSize: number;
  lifecycle?: string;
  operationType?: string;
  currency?: string;
  dateFrom?: string;
  dateTo?: string;
  payer?: string;
}

export interface WalletHistorySummary {
  id: string;
  lifecycle: string;
  operationType: string;
  operationId: string;
  amount: number;
  currency: string;
  payeeSnapshot: { displayName: string | null; reference: string | null; maskedIdentifier: string | null };
  issuedAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
  expiresAt: string;
  attempts: number;
  resendCount: number;
  accountingTransaction: { id: string; status: string; amount: number | null } | null;
}

interface WalletHistoryRow {
  authorization_id: string;
  lifecycle: string;
  operation_type: string;
  operation_id: string;
  amount: number | string;
  currency: string;
  payee_display_name: string | null;
  payee_reference: string | null;
  payee_masked_identifier: string | null;
  issued_at: string;
  approved_at: string | null;
  consumed_at: string | null;
  expires_at: string;
  attempts: number | string;
  resend_count: number | string;
  accounting_transaction_id: string | null;
  accounting_transaction_status: string | null;
  accounting_amount: number | string | null;
}

function buildWhereClause(params: WalletHistoryListParams): { clause: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let index = 1;

  if (params.lifecycle) {
    conditions.push(`w.lifecycle = $${index}`);
    values.push(params.lifecycle);
    index++;
  }
  if (params.operationType) {
    conditions.push(`w.operation_type = $${index}`);
    values.push(params.operationType);
    index++;
  }
  if (params.currency) {
    conditions.push(`w.currency = $${index}`);
    values.push(params.currency);
    index++;
  }
  if (params.dateFrom) {
    conditions.push(`w.created_at >= $${index}::date`);
    values.push(params.dateFrom);
    index++;
  }
  if (params.dateTo) {
    conditions.push(`w.created_at < $${index}::date + INTERVAL '1 day'`);
    values.push(params.dateTo);
    index++;
  }
  if (params.payer) {
    conditions.push(`(
      u.username ILIKE $${index}
      OR p.display_name ILIKE $${index}
      OR w.payer_user_id::text ILIKE $${index}
      OR w.payer_party_id::text ILIKE $${index}
    )`);
    values.push(`%${params.payer}%`);
  }

  return { clause: conditions.length ? conditions.join(' AND ') : 'TRUE', values };
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

export const adminWalletHistoryQuery = {
  async list(params: WalletHistoryListParams): Promise<{
    data: WalletHistorySummary[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
  }> {
    const { clause, values } = buildWhereClause(params);
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total
       FROM konektag.wallet_debit_authorizations w
       LEFT JOIN konektag.users u ON u.id = w.payer_user_id
       LEFT JOIN konektag.parties p ON p.id = w.payer_party_id
       WHERE ${clause}`,
      values,
    );
    const total = Number.parseInt(countResult.rows[0]?.total || '0', 10);
    const totalPages = total ? Math.ceil(total / params.pageSize) : 0;
    if (!total) {
      return { data: [], pagination: { page: params.page, pageSize: params.pageSize, total, totalPages, hasMore: false } };
    }

    const offset = (params.page - 1) * params.pageSize;
    const { rows } = await pool.query<WalletHistoryRow>(
      `WITH authorizations AS (
         SELECT w.id, w.lifecycle, w.operation_type, w.operation_id, w.amount, w.currency,
                w.payee_snapshot ->> 'displayName' AS payee_display_name,
                w.payee_snapshot ->> 'reference' AS payee_reference,
                w.payee_snapshot ->> 'maskedIdentifier' AS payee_masked_identifier,
                w.created_at AS issued_at, w.approved_at, w.consumed_at, w.expires_at,
                w.attempts, w.resend_count
         FROM konektag.wallet_debit_authorizations w
         LEFT JOIN konektag.users u ON u.id = w.payer_user_id
         LEFT JOIN konektag.parties p ON p.id = w.payer_party_id
         WHERE ${clause}
       ), financial_candidates AS (
         SELECT a.id AS authorization_id, ft.id AS accounting_transaction_id, ft.status AS accounting_transaction_status,
                CASE WHEN COUNT(le.id) = 0 THEN NULL
                  ELSE SUM(CASE WHEN le.entry_side = 'debit' THEN le.amount ELSE 0 END)
                END AS accounting_amount,
                COUNT(*) OVER (PARTITION BY a.id) AS candidate_count
         FROM authorizations a
         JOIN konektag.financial_transactions ft
           ON ft.business_reference = a.operation_id
          AND ft.transaction_type = CASE a.operation_type
            WHEN 'recharge' THEN 'wallet_recharge'
            WHEN 'qr_pay' THEN 'qr_payment'
            WHEN 'transfer' THEN 'transfer'
            WHEN 'api_payment' THEN 'api_payment'
            ELSE NULL
          END
         LEFT JOIN konektag.ledger_entries le ON le.transaction_id = ft.id
         GROUP BY a.id, ft.id, ft.status
       )
       SELECT a.id AS authorization_id, a.lifecycle, a.operation_type, a.operation_id, a.amount, a.currency,
              a.payee_display_name, a.payee_reference, a.payee_masked_identifier,
              a.issued_at, a.approved_at, a.consumed_at, a.expires_at, a.attempts, a.resend_count,
              f.accounting_transaction_id, f.accounting_transaction_status, f.accounting_amount
       FROM authorizations a
       LEFT JOIN financial_candidates f ON f.authorization_id = a.id AND f.candidate_count = 1
       ORDER BY a.issued_at DESC, a.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, params.pageSize, offset],
    );

    return {
      data: rows.map((row) => ({
        id: row.authorization_id,
        lifecycle: row.lifecycle,
        operationType: row.operation_type,
        operationId: row.operation_id,
        amount: Number(row.amount),
        currency: row.currency,
        payeeSnapshot: {
          displayName: row.payee_display_name,
          reference: row.payee_reference,
          maskedIdentifier: row.payee_masked_identifier,
        },
        issuedAt: toIso(row.issued_at),
        approvedAt: row.approved_at ? toIso(row.approved_at) : null,
        consumedAt: row.consumed_at ? toIso(row.consumed_at) : null,
        expiresAt: toIso(row.expires_at),
        attempts: Number(row.attempts),
        resendCount: Number(row.resend_count),
        accountingTransaction: row.accounting_transaction_id && row.accounting_transaction_status ? {
          id: row.accounting_transaction_id,
          status: row.accounting_transaction_status,
          amount: row.accounting_amount === null ? null : Number(row.accounting_amount),
        } : null,
      })),
      pagination: { page: params.page, pageSize: params.pageSize, total, totalPages, hasMore: params.page < totalPages },
    };
  },
};
