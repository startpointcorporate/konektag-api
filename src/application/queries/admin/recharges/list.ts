import pool from '../../../../infrastructure/database/pool.ts';
import type { RechargeSummaryDTO, PaginatedResultDTO } from './dto.ts';

export interface RechargeListParams {
  page: number;
  pageSize: number;
  sort: 'created_at' | 'requested_amount' | 'recharge_status';
  direction: 'asc' | 'desc';
  search?: string;
  rechargeStatus?: string;
  providerStatus?: string;
  ledgerStatus?: string;
  paymentMethod?: string;
  paymentProvider?: string;
  currency?: string;
  country?: string;
  dateFrom?: string;
  dateTo?: string;
  notCredited?: boolean;
  hasAnomaly?: boolean;
}

function buildWhereClause(params: RechargeListParams): { clause: string; values: unknown[] } {
  const conditions: string[] = ['r.deleted_at IS NULL'];
  const values: unknown[] = [];
  let idx = 1;

  if (params.search) {
    conditions.push(`(r.internal_reference ILIKE $${idx} OR r.recharge_name ILIKE $${idx} OR u.username ILIKE $${idx})`);
    values.push(`%${params.search}%`);
    idx++;
  }

  if (params.rechargeStatus) {
    conditions.push(`r.recharge_status = $${idx}`);
    values.push(params.rechargeStatus);
    idx++;
  }

  if (params.providerStatus) {
    conditions.push(`r.provider_status_detail = $${idx}`);
    values.push(params.providerStatus);
    idx++;
  }

  if (params.ledgerStatus) {
    conditions.push(`r.ledger_status = $${idx}`);
    values.push(params.ledgerStatus);
    idx++;
  }

  if (params.paymentMethod) {
    conditions.push(`r.payment_method = $${idx}`);
    values.push(params.paymentMethod);
    idx++;
  }

  if (params.paymentProvider) {
    conditions.push(`r.payment_provider = $${idx}`);
    values.push(params.paymentProvider);
    idx++;
  }

  if (params.currency) {
    conditions.push(`r.requested_currency = $${idx}`);
    values.push(params.currency);
    idx++;
  }

  if (params.country) {
    conditions.push(`r.country = $${idx}`);
    values.push(params.country);
    idx++;
  }

  if (params.dateFrom) {
    conditions.push(`r.created_at >= $${idx}`);
    values.push(params.dateFrom);
    idx++;
  }

  if (params.dateTo) {
    conditions.push(`r.created_at <= $${idx}`);
    values.push(params.dateTo);
    idx++;
  }

  if (params.notCredited) {
    conditions.push(`r.credited_amount IS NULL`);
  }

  if (params.hasAnomaly) {
    conditions.push(`r.anomaly IS NOT NULL`);
  }

  return { clause: conditions.join(' AND '), values };
}

export const adminRechargeListQuery = {
  async list(params: RechargeListParams): Promise<PaginatedResultDTO<RechargeSummaryDTO>> {
    const { clause, values } = buildWhereClause(params);

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total
       FROM konektag.recharge_projection r
       LEFT JOIN konektag.users u ON u.keycloak_id = r.keycloak_id
       WHERE ${clause}`,
      values,
    );
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    if (total === 0) {
      return { data: [], pagination: { page: params.page, pageSize: params.pageSize, total: 0, totalPages: 0, hasMore: false } };
    }

    const totalPages = Math.ceil(total / params.pageSize);
    const offset = (params.page - 1) * params.pageSize;

    const orderDir = params.direction === 'asc' ? 'ASC' : 'DESC';
    const orderField = params.sort === 'created_at' ? 'r.created_at'
      : params.sort === 'requested_amount' ? 'r.requested_amount'
      : 'r.recharge_status';

    const { rows } = await pool.query(
      `SELECT
        r.id, r.recharge_name, r.keycloak_id,
        u.id AS user_id, u.username AS user_name,
        r.requested_amount, r.requested_currency,
        r.credited_amount, r.credited_currency,
        r.payment_method, r.payment_provider, pp.name AS payment_provider_name,
        r.recharge_status, r.provider_status_detail, r.ledger_status,
        r.provider_reference,
        r.internal_reference, r.country,
        r.created_at, r.updated_at, r.confirmed_at, r.reversed_at,
        r.anomaly
       FROM konektag.recharge_projection r
       LEFT JOIN konektag.users u ON u.keycloak_id = r.keycloak_id
       LEFT JOIN konektag.payment_providers pp ON pp.code = r.payment_provider
       WHERE ${clause}
       ORDER BY ${orderField} ${orderDir}
       LIMIT $${values.length + 1}
       OFFSET $${values.length + 2}`,
      [...values, params.pageSize, offset],
    );

    const data: RechargeSummaryDTO[] = rows.map(r => ({
      id: r.id,
      rechargeName: r.recharge_name,
      userId: r.user_id || r.keycloak_id || null,
      userName: r.user_name || null,
      userEmail: null,
      requestedAmount: Number(r.requested_amount),
      requestedCurrency: r.requested_currency,
      creditedAmount: r.credited_amount ? Number(r.credited_amount) : null,
      creditedCurrency: r.credited_currency || null,
      paymentMethod: r.payment_method,
      paymentProvider: r.payment_provider,
      paymentProviderName: r.payment_provider_name || r.payment_provider,
      rechargeStatus: r.recharge_status,
      providerStatusDetail: r.provider_status_detail,
      ledgerStatus: r.ledger_status,
      providerReference: r.provider_reference,
      internalReference: r.internal_reference || r.recharge_name,
      country: r.country,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      confirmedAt: r.confirmed_at,
      reversedAt: r.reversed_at,
      anomaly: r.anomaly,
      hasAnomaly: !!r.anomaly,
    }));

    return {
      data,
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
