import pool from '../../../../infrastructure/database/pool.ts';

export interface MobileMoneyQueueParams {
  page: number;
  pageSize: number;
  country?: string;
  provider?: string;
  operator?: string;
  sourceType?: 'api_payment';
  ageHours?: number;
}

export interface MobileMoneyQueueRow {
  sourceType: 'api_payment';
  sourceId: string;
  country: string | null;
  provider: string | null;
  operator: string | null;
  expectedAmount: number;
  currency: string;
  createdAt: string;
  operatorMissing: boolean;
}

interface QueueDatabaseRow {
  source_type: 'api_payment';
  source_id: string;
  country: string | null;
  provider: string | null;
  operator: string | null;
  expected_amount: number | string;
  currency: string;
  created_at: string;
}

function buildWhere(params: MobileMoneyQueueParams): { clause: string; values: unknown[] } {
  const conditions = ['1 = 1'];
  const values: unknown[] = [];
  const add = (condition: string, value: unknown) => {
    values.push(value);
    conditions.push(condition.replace('?', `$${values.length}`));
  };
  if (params.country) add('country = ?', params.country);
  if (params.provider) add('provider = ?', params.provider);
  if (params.operator) add('operator = ?', params.operator);
  if (params.sourceType) add('source_type = ?', params.sourceType);
  if (params.ageHours) add("created_at <= now() - (?::int * interval '1 hour')", params.ageHours);
  return { clause: conditions.join(' AND '), values };
}

const queueSql = `
   SELECT 'api_payment'::varchar AS source_type, o.id::varchar AS source_id,
          CASE WHEN COALESCE(le.country_code, mp.country) ~ '^[A-Za-z]{2}$' THEN upper(COALESCE(le.country_code, mp.country)) ELSE NULL END AS country,
         NULL::varchar AS provider, NULL::varchar AS operator,
         o.external_amount AS expected_amount, upper(o.currency) AS currency, o.created_at
  FROM konektag.api_payment_orders o
   LEFT JOIN konektag.merchant_profiles mp ON mp.id = o.merchant_profile_id AND mp.deleted_at IS NULL
   LEFT JOIN konektag.legal_entities le ON le.id = o.settlement_legal_entity_id AND le.deleted_at IS NULL
  WHERE o.environment = 'live' AND o.state = 'awaiting_mobile_money' AND o.payment_method = 'mobile_money'
    AND NOT EXISTS (SELECT 1 FROM konektag.mobile_money_receipts mr
                    WHERE mr.source_type = 'api_payment' AND mr.source_id = o.id::varchar)`

export const adminMobileMoneyQueueQuery = {
  async list(params: MobileMoneyQueueParams): Promise<{
    data: MobileMoneyQueueRow[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number; hasMore: boolean };
  }> {
    const { clause, values } = buildWhere(params);
    const count = await pool.query<{ total: string }>(`SELECT COUNT(*) AS total FROM (${queueSql}) queue WHERE ${clause}`, values);
    const total = Number(count.rows[0]?.total ?? 0);
    const totalPages = total ? Math.ceil(total / params.pageSize) : 0;
    if (!total) return { data: [], pagination: { page: params.page, pageSize: params.pageSize, total, totalPages, hasMore: false } };

    const offset = (params.page - 1) * params.pageSize;
    const { rows } = await pool.query<QueueDatabaseRow>(
      `SELECT * FROM (${queueSql}) queue WHERE ${clause}
       ORDER BY created_at ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, params.pageSize, offset],
    );
    return {
      data: rows.map((row) => ({
        sourceType: row.source_type,
        sourceId: row.source_id,
        country: row.country,
        provider: row.provider,
        operator: row.operator,
        expectedAmount: Number(row.expected_amount),
        currency: row.currency,
        createdAt: row.created_at,
        operatorMissing: !row.operator,
      })),
      pagination: { page: params.page, pageSize: params.pageSize, total, totalPages, hasMore: params.page < totalPages },
    };
  },
};
