import pool from '../../../../infrastructure/database/pool.ts';

export interface CardTransactionListParams {
  page: number;
  pageSize: number;
  provider?: string;
  country?: string;
  sourceType?: string;
  state?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface CardTransactionSummary {
  provider: string;
  providerReference: string;
  country: string | null;
  brand: string | null;
  funding: string | null;
  bin: string | null;
  sourceType: string;
  sourceRef: string;
  expectedAmount: number;
  expectedCurrency: string;
  state: string;
  checkoutSettlementState: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProviderAttemptRow {
  provider: string;
  provider_reference: string;
  provider_country: string | null;
  provider_card_brand: string | null;
  provider_card_funding: string | null;
  provider_card_bin: string | null;
  source_type: string;
  source_id: string;
  expected_amount: number | string;
  expected_currency: string;
  state: string;
  checkout_settlement_state: string | null;
  created_at: string;
  updated_at: string;
}

function maskProviderReference(reference: string): string {
  if (reference.length <= 10) return '***';
  return `${reference.slice(0, 6)}...${reference.slice(-6)}`;
}

function buildWhereClause(params: CardTransactionListParams): { clause: string; values: unknown[] } {
  // This allowlist prevents non-card providers from appearing if more providers are added.
  const conditions = ["p.provider = ANY($1::varchar[])"];
  const values: unknown[] = [['stripe']];
  let index = 2;

  if (params.provider) {
    conditions.push(`p.provider = $${index}`);
    values.push(params.provider);
    index++;
  }
  if (params.country) {
    conditions.push(`p.provider_country = $${index}`);
    values.push(params.country);
    index++;
  }
  if (params.sourceType) {
    conditions.push(`p.source_type = $${index}`);
    values.push(params.sourceType);
    index++;
  }
  if (params.state) {
    conditions.push(`p.state = $${index}`);
    values.push(params.state);
    index++;
  }
  if (params.dateFrom) {
    conditions.push(`p.created_at >= $${index}::date`);
    values.push(params.dateFrom);
    index++;
  }
  if (params.dateTo) {
    conditions.push(`p.created_at < $${index}::date + INTERVAL '1 day'`);
    values.push(params.dateTo);
  }

  return { clause: conditions.join(' AND '), values };
}

export const adminCardTransactionListQuery = {
  async list(params: CardTransactionListParams): Promise<{
    data: CardTransactionSummary[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
  }> {
    const { clause, values } = buildWhereClause(params);
    const countResult = await pool.query(
      `SELECT COUNT(*) AS total
       FROM konektag.payment_provider_attempts p
       WHERE ${clause}`,
      values,
    );
    const total = Number.parseInt(countResult.rows[0]?.total || '0', 10);
    const totalPages = total ? Math.ceil(total / params.pageSize) : 0;

    if (!total) {
      return { data: [], pagination: { page: params.page, pageSize: params.pageSize, total, totalPages, hasMore: false } };
    }

    const offset = (params.page - 1) * params.pageSize;
    const { rows } = await pool.query<ProviderAttemptRow>(
      `SELECT
         p.provider, p.provider_reference, p.provider_country, p.provider_card_brand,
         p.provider_card_funding, p.provider_card_bin, p.source_type, p.source_id,
         p.expected_amount, p.expected_currency, p.state, p.created_at, p.updated_at,
         o.state AS checkout_settlement_state
       FROM konektag.payment_provider_attempts p
       LEFT JOIN konektag.api_payment_orders o
         ON p.source_type = 'api_payment' AND o.id::text = p.source_id
       WHERE ${clause}
       ORDER BY p.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, params.pageSize, offset],
    );

    return {
      data: rows.map((row) => ({
        provider: row.provider,
        providerReference: maskProviderReference(row.provider_reference),
        country: row.provider_country,
        brand: row.provider_card_brand,
        funding: row.provider_card_funding,
        // Defend against legacy or manually corrupted data despite the database constraint.
        bin: row.provider_card_bin && /^\d{8}$/.test(row.provider_card_bin) ? row.provider_card_bin : null,
        sourceType: row.source_type,
        sourceRef: row.source_id,
        expectedAmount: Number(row.expected_amount),
        expectedCurrency: row.expected_currency,
        state: row.state,
        checkoutSettlementState: row.checkout_settlement_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      pagination: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages,
        hasMore: params.page < totalPages,
      },
    };
  },
};
