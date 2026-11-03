import pool from '../database/pool.ts';

type Queryable = Pick<typeof pool, 'query'>;

export interface FinanceListFilters {
  legalEntity?: string;
  status?: string;
  currency?: string;
  corridor?: string;
  crossEntity?: boolean;
  merchantUserId?: string;
  page?: number;
  limit?: number;
}

export class FinanceReadRepository {
  constructor(private readonly db: Queryable = pool) {}

  async listLegalEntities() {
    const { rows } = await this.db.query(
      `SELECT code, legal_name, country_code, base_currency,
              CASE status WHEN 'APPROVED' THEN 'Active' ELSE status END AS status,
              frappe_company, regulatory_identifier
       FROM konektag.legal_entities
       WHERE status = 'APPROVED' AND deleted_at IS NULL
       ORDER BY code
       LIMIT 20`,
    );
    return rows;
  }

  async getLegalEntity(code: string) {
    const { rows } = await this.db.query(
      `SELECT code, legal_name, country_code, base_currency,
              CASE status WHEN 'APPROVED' THEN 'Active' ELSE status END AS status
       FROM konektag.legal_entities
       WHERE code = $1 AND deleted_at IS NULL
       LIMIT 1`,
      [code],
    );
    return rows[0] || null;
  }

  async listActiveCorridors() {
    const { rows } = await this.db.query(
      `SELECT rp.corridor_id AS code, MIN(rp.profile_name) AS label,
              rp.country_of_origin AS origin_country,
              rp.country_of_destination AS destination_country,
              MIN(le.code) AS origin_legal_entity,
              MIN(destination.code) AS destination_legal_entity
       FROM konektag.regulatory_profiles rp
       JOIN konektag.legal_entities le ON le.id = rp.legal_entity_id
       LEFT JOIN konektag.legal_entities destination
         ON destination.country_code = rp.country_of_destination
        AND destination.status = 'APPROVED' AND destination.deleted_at IS NULL
       WHERE rp.status = 'APPROVED' AND rp.deleted_at IS NULL
         AND (rp.valid_until IS NULL OR rp.valid_until >= CURRENT_DATE)
       GROUP BY rp.corridor_id, rp.country_of_origin, rp.country_of_destination
       ORDER BY rp.corridor_id
       LIMIT 10`,
    );
    return rows;
  }

  async getEntityFinancialPosition(entityCode: string) {
    const { rows } = await this.db.query(
      `WITH entity AS (
         SELECT id, code, base_currency FROM konektag.legal_entities
         WHERE code = $1 AND deleted_at IS NULL
       ), local_position AS (
         SELECT le.currency,
                COALESCE(SUM(CASE WHEN fa.is_cash AND le.entry_side = 'debit' THEN le.amount
                                  WHEN fa.is_cash AND le.entry_side = 'credit' THEN -le.amount ELSE 0 END), 0) AS cash_balance,
                COALESCE(SUM(CASE WHEN fa.account_type = 'liability' AND le.entry_side = 'credit' THEN le.amount
                                  WHEN fa.account_type = 'liability' AND le.entry_side = 'debit' THEN -le.amount ELSE 0 END), 0) AS merchant_payable,
                MAX(le.created_at) AS calculated_at
         FROM entity e
         LEFT JOIN konektag.ledger_entries le ON le.legal_entity_id = e.id
         LEFT JOIN konektag.financial_accounts fa ON fa.account_code = le.account_code
         WHERE le.account_code IN ('1100', '2000', '401000', '512000', '521000', '6000', '7000')
         GROUP BY le.currency
       ), network_position AS (
         SELECT ip.currency,
                COALESCE(SUM(ip.amount) FILTER (WHERE (ip.direction = 'A_TO_B' AND b.id = e.id)
                                                  OR (ip.direction = 'B_TO_A' AND a.id = e.id)), 0) AS network_receivable,
                COALESCE(SUM(ip.amount) FILTER (WHERE (ip.direction = 'A_TO_B' AND a.id = e.id)
                                                  OR (ip.direction = 'B_TO_A' AND b.id = e.id)), 0) AS network_payable,
                MAX(ip.updated_at) AS calculated_at
         FROM entity e
         JOIN konektag.intercompany_positions ip ON ip.legal_entity_a_id = e.id OR ip.legal_entity_b_id = e.id
         JOIN konektag.legal_entities a ON a.id = ip.legal_entity_a_id
         JOIN konektag.legal_entities b ON b.id = ip.legal_entity_b_id
         WHERE ip.status IN ('OPEN', 'INCLUDED_IN_BATCH') AND ip.deleted_at IS NULL
         GROUP BY ip.currency
       ), currencies AS (
         SELECT currency FROM local_position UNION SELECT currency FROM network_position
       )
       SELECT $1::text AS legal_entity, currencies.currency,
              COALESCE(lp.cash_balance, 0) AS cash_balance,
              COALESCE(lp.merchant_payable, 0) AS merchant_payable,
              COALESCE(np.network_receivable, 0) AS network_receivable,
              COALESCE(np.network_payable, 0) AS network_payable,
              COALESCE(np.network_receivable, 0) - COALESCE(np.network_payable, 0) AS network_net_position,
              GREATEST(lp.calculated_at, np.calculated_at) AS calculated_at
       FROM currencies
       LEFT JOIN local_position lp USING (currency)
       LEFT JOIN network_position np USING (currency)
       ORDER BY currencies.currency
       LIMIT 3`,
      [entityCode],
    );
    return rows;
  }

  async listKlots(search: string, page: number, limit: number) {
    const offset = (page - 1) * limit;
    const term = search ? `%${search}%` : null;
    const { rows } = await this.db.query(
      `SELECT k.klot_ref AS klot_id, k.rail AS source_type, le.code AS origin_legal_entity,
              k.economic_currency AS origin_currency, k.quantity_k AS initial_quantity,
              k.remaining_quantity, NULL::text AS current_owner, k.rail AS provider,
              k.rail_ref AS provider_reference, ft.operation_id, ft.corridor_id AS corridor,
              k.created_at AS acquisition_date, k.status, k.status AS origin_status,
              COUNT(*) OVER() AS total_count
       FROM konektag.klots k
       JOIN konektag.legal_entities le ON le.id = k.origin_entity_id
       LEFT JOIN LATERAL (
         SELECT operation_id, corridor_id FROM konektag.financial_transactions
         WHERE klot_id = k.id ORDER BY created_at LIMIT 1
       ) ft ON true
       WHERE k.deleted_at IS NULL
         AND ($1::text IS NULL OR k.klot_ref ILIKE $1 OR COALESCE(k.rail_ref, '') ILIKE $1
              OR COALESCE(ft.operation_id, '') ILIKE $1)
       ORDER BY k.created_at DESC, k.klot_ref
       LIMIT $2 OFFSET $3`,
      [term, limit, offset],
    );
    return { data: rows.map(({ total_count: _total, ...row }) => row), total: Number(rows[0]?.total_count || 0) };
  }

  async getKlot(klotRef: string) {
    const { rows } = await this.db.query(
      `SELECT k.id, k.klot_ref AS klot_id, k.rail AS source_type,
              le.code AS origin_legal_entity, k.origin_country,
              k.economic_currency AS origin_currency, k.rail AS provider,
              k.rail_ref AS provider_reference, NULL::text AS voucher_id,
              COALESCE(k.issuer, k.rail) AS issuer_or_rail, ft.operation_id,
              source_ft.operation_id AS source_operation_id,
              NULL::text AS funding_operation_id, NULL::text AS funding_transaction_id,
              ft.corridor_id AS corridor, k.quantity_k AS initial_quantity,
              k.remaining_quantity, 0 AS k_send_depth, k.klot_ref AS root_klot_id,
              NULL::text AS parent_klot_id, k.restrictions, NULL::text AS current_owner,
              k.status, k.status AS origin_status, k.created_at AS acquisition_date,
              k.updated_at AS modified
       FROM konektag.klots k
       JOIN konektag.legal_entities le ON le.id = k.origin_entity_id
       LEFT JOIN LATERAL (
         SELECT operation_id, source_operation_id, corridor_id
         FROM konektag.financial_transactions WHERE klot_id = k.id
         ORDER BY created_at LIMIT 1
       ) ft ON true
       LEFT JOIN konektag.financial_transactions source_ft ON source_ft.id = ft.source_operation_id
       WHERE k.klot_ref = $1 AND k.deleted_at IS NULL`,
      [klotRef],
    );
    if (!rows[0]) return null;

    const klot = rows[0];
    const { rows: movements } = await this.db.query(
      `SELECT 'ALLOCATION' AS movement_type, ka.allocated_quantity AS quantity,
              ft.operation_id, origin.code AS from_party, le.client_id AS to_party,
              entity.code AS legal_entity, ft.corridor_id AS corridor, ka.created_at
       FROM konektag.klot_allocations ka
       JOIN konektag.financial_transactions ft ON ft.id = ka.transaction_id
       JOIN konektag.klots k ON k.id = ka.klot_id
       JOIN konektag.legal_entities origin ON origin.id = k.origin_entity_id
       LEFT JOIN konektag.legal_entities entity ON entity.id = ft.legal_entity_id
       LEFT JOIN LATERAL (
         SELECT client_id FROM konektag.ledger_entries
         WHERE transaction_id = ft.id AND entry_side = 'credit' ORDER BY created_at LIMIT 1
       ) le ON true
       WHERE ka.klot_id = $1
       ORDER BY ka.created_at DESC
       LIMIT 100`,
      [klot.id],
    );
    delete klot.id;
    return { klot, movements };
  }

  async listMerchantSales(filters: FinanceListFilters) {
    const limit = filters.limit || 25;
    const page = filters.page || 1;
    const { rows } = await this.db.query(
      `SELECT ms.id, ms.sale_ref AS sale_id, ms.merchant_profile_id, ms.legal_entity_id, COALESCE(ms.k_operation_id::text,ft.operation_id) AS operation_id, owner.keycloak_id AS user_id,
              mp.business_name AS merchant, le.code AS legal_entity, ms.currency,
              ft.corridor_id AS corridor, ms.gross_amount,
              COALESCE(consumption.k_quantity, alloc.k_quantity, 0) AS k_quantity, ms.commission_amount,
              ms.net_amount AS net_payable, ft.transaction_type AS payment_channel,
              EXISTS (SELECT 1 FROM konektag.intercompany_positions ip
                      WHERE ip.source_sale_id = ms.id AND ip.deleted_at IS NULL) AS cross_entity,
              ms.status, ms.created_at AS sale_date, ms.settlement_due_date,
              COUNT(*) OVER() AS total_count
       FROM konektag.merchant_sales ms
       JOIN konektag.merchant_profiles mp ON mp.id = ms.merchant_profile_id
       LEFT JOIN konektag.legal_entities le ON le.id = ms.legal_entity_id
       LEFT JOIN konektag.financial_transactions ft ON ft.id = ms.transaction_id
       LEFT JOIN konektag.users owner ON owner.id = mp.user_id
       LEFT JOIN LATERAL (
         SELECT SUM(quantity) AS k_quantity
         FROM konektag.points_merchant_consumptions WHERE monetary_transaction_id = ms.transaction_id
           OR k_operation_id = ms.k_operation_id
       ) consumption ON true
       LEFT JOIN LATERAL (
         SELECT SUM(allocated_quantity) AS k_quantity
         FROM konektag.klot_allocations WHERE transaction_id = ms.transaction_id
       ) alloc ON true
       WHERE ms.deleted_at IS NULL
         AND ($1::text IS NULL OR le.code = $1)
         AND ($2::text IS NULL OR ms.status = $2)
         AND ($3::text IS NULL OR ms.currency = $3)
         AND ($4::text IS NULL OR ft.corridor_id = $4)
         AND (NOT $5::boolean OR EXISTS (SELECT 1 FROM konektag.intercompany_positions ip
                                         WHERE ip.source_sale_id = ms.id AND ip.deleted_at IS NULL))
         AND ($6::uuid IS NULL OR mp.user_id = $6 OR EXISTS (
               SELECT 1 FROM konektag.merchant_memberships mm
               WHERE mm.merchant_profile_id = mp.id AND mm.user_id = $6 AND mm.status = 'active'))
       ORDER BY ms.created_at DESC, ms.sale_ref
       LIMIT $7 OFFSET $8`,
      [filters.legalEntity || null, filters.status || null, filters.currency || null,
       filters.corridor || null, filters.crossEntity || false, filters.merchantUserId || null,
       limit, (page - 1) * limit],
    );
    return { data: rows.map(({ total_count: _total, ...row }) => row), total: Number(rows[0]?.total_count || 0) };
  }

  async summarizeMerchantSales(merchantUserId: string) {
    const { rows: [summary] } = await this.db.query(
      `SELECT
         COALESCE(SUM(ms.gross_amount) FILTER (WHERE ms.created_at::date = CURRENT_DATE), 0) AS today_gross,
         COALESCE(SUM(ms.commission_amount) FILTER (WHERE ms.created_at::date = CURRENT_DATE), 0) AS today_commission,
         COALESCE(SUM(ms.net_amount) FILTER (WHERE ms.created_at::date = CURRENT_DATE), 0) AS today_net,
         COALESCE(SUM(ms.net_amount) FILTER (WHERE ms.status IN ('CREATED', 'PARTIALLY_SETTLED')), 0) AS pending_net,
         COALESCE(SUM(ms.net_amount) FILTER (WHERE ms.status = 'SETTLED'), 0) AS settled_net,
         MIN(ms.settlement_due_date) FILTER (WHERE ms.status IN ('CREATED', 'PARTIALLY_SETTLED')) AS next_due_date
       FROM konektag.merchant_sales ms
       JOIN konektag.merchant_profiles mp ON mp.id = ms.merchant_profile_id
       WHERE ms.deleted_at IS NULL AND (mp.user_id = $1 OR EXISTS (
         SELECT 1 FROM konektag.merchant_memberships mm
         WHERE mm.merchant_profile_id = mp.id AND mm.user_id = $1 AND mm.status = 'active'))`,
      [merchantUserId],
    );
    return {
      today: { gross: Number(summary.today_gross), commission: Number(summary.today_commission), net: Number(summary.today_net) },
      toSettle: { net: Number(summary.pending_net) },
      settled: { net: Number(summary.settled_net) },
      nextDueDate: summary.next_due_date,
    };
  }

  async getMerchantSale(saleRef: string) {
    const { rows } = await this.db.query(
      `SELECT ms.id, ms.transaction_id, ms.sale_ref AS sale_id, COALESCE(ms.k_operation_id::text,ft.operation_id) AS operation_id,
              source_ft.operation_id AS source_operation_id, ft.transaction_type AS sale_intent_type,
              ft.business_reference AS sale_intent_id, ft.transaction_type AS payment_channel,
              owner.keycloak_id AS user_id, mp.business_name AS merchant,
              NULL::text AS establishment, le.code AS legal_entity,
              counterparty.code AS counterparty_entity, ms.currency, ft.corridor_id AS corridor,
              ms.gross_amount, COALESCE(consumption.k_quantity, alloc.k_quantity, 0) AS k_quantity,
              ms.commission_rate, ms.commission_amount, 0 AS bonus_amount,
              ms.tax_amount AS other_fee_amount, ms.net_amount AS net_payable,
              EXISTS (SELECT 1 FROM konektag.intercompany_positions ip WHERE ip.source_sale_id = ms.id AND ip.deleted_at IS NULL) AS cross_entity,
              position.position_ref AS position_id, ft.value_date, ms.settlement_due_date,
              ms.status, ms.created_at AS sale_date, NULL::text AS created_by, ms.updated_at AS modified
       FROM konektag.merchant_sales ms
       JOIN konektag.merchant_profiles mp ON mp.id = ms.merchant_profile_id
       LEFT JOIN konektag.legal_entities le ON le.id = ms.legal_entity_id
       LEFT JOIN konektag.users owner ON owner.id = mp.user_id
       LEFT JOIN konektag.financial_transactions ft ON ft.id = ms.transaction_id
       LEFT JOIN konektag.financial_transactions source_ft ON source_ft.id = ft.source_operation_id
       LEFT JOIN konektag.counterparty_entities counterparty ON counterparty.id = ft.counterparty_entity_id
       LEFT JOIN LATERAL (
         SELECT SUM(quantity) AS k_quantity
         FROM konektag.points_merchant_consumptions WHERE monetary_transaction_id = ms.transaction_id
           OR k_operation_id = ms.k_operation_id
       ) consumption ON true
       LEFT JOIN LATERAL (SELECT SUM(allocated_quantity) AS k_quantity FROM konektag.klot_allocations WHERE transaction_id = ms.transaction_id) alloc ON true
       LEFT JOIN LATERAL (SELECT position_ref FROM konektag.intercompany_positions WHERE source_sale_id = ms.id AND deleted_at IS NULL ORDER BY created_at LIMIT 1) position ON true
       WHERE ms.sale_ref = $1 AND ms.deleted_at IS NULL`,
      [saleRef],
    );
    if (!rows[0]) return null;
    const sale = rows[0];
    const { rows: allocations } = await this.db.query(
      `SELECT k.klot_ref AS "klotId", ka.allocated_quantity AS quantity,
              ROW_NUMBER() OVER (ORDER BY ka.created_at, ka.id) AS sequence,
              le.code AS "originLegalEntity", k.economic_currency AS "originCurrency"
       FROM konektag.klot_allocations ka
       JOIN konektag.klots k ON k.id = ka.klot_id
       JOIN konektag.legal_entities le ON le.id = k.origin_entity_id
       WHERE ka.transaction_id = $1 ORDER BY ka.created_at, ka.id LIMIT 50`,
      [sale.transaction_id],
    );
    delete sale.id;
    delete sale.transaction_id;
    return { sale, klotAllocations: allocations };
  }

  async listIntercompany(filters: { legalEntity?: string; counterparty?: string; debtor?: string }) {
    const { rows } = await this.db.query(
      `${this.intercompanySelect()}
       WHERE ip.status = 'OPEN' AND ip.deleted_at IS NULL
         AND ($1::text IS NULL OR CASE ip.direction WHEN 'A_TO_B' THEN b.code ELSE a.code END = $1)
         AND ($2::text IS NULL OR a.code = $2 OR b.code = $2)
         AND ($3::text IS NULL OR CASE ip.direction WHEN 'A_TO_B' THEN a.code ELSE b.code END = $3)
       ORDER BY ip.created_at DESC LIMIT 200`,
      [filters.legalEntity || null, filters.counterparty || null, filters.debtor || null],
    );
    return rows;
  }

  async getIntercompany(positionRef: string) {
    const { rows } = await this.db.query(
      `${this.intercompanySelect(`, ms.sale_ref AS merchant_sale,
              ft.source_currency, ft.currency AS execution_currency, ft.fx_rate AS valuation_rate,
              ft.completed_at AS valuation_timestamp, NULL::text AS valuation_source,
              ip.clearing_batch_id AS clearing_batch,
              CASE WHEN ip.clearing_batch_id IS NULL THEN NULL ELSE ip.status END AS clearing_status,
              NULL::text AS original_position_id, NULL::text AS reversal_position_id`)}
       WHERE ip.position_ref = $1 AND ip.deleted_at IS NULL`,
      [positionRef],
    );
    if (!rows[0]) return null;
    const position = rows[0];
    const { rows: sources } = await this.db.query(
      `SELECT k.klot_ref AS "klotId", ka.allocated_quantity AS "kQuantity",
              le.code AS "originLegalEntity", ka.allocated_quantity AS "allocatedLocalAmount"
       FROM konektag.intercompany_positions ip
       JOIN konektag.merchant_sales ms ON ms.id = ip.source_sale_id
       JOIN konektag.klot_allocations ka ON ka.transaction_id = ms.transaction_id
       JOIN konektag.klots k ON k.id = ka.klot_id
       JOIN konektag.legal_entities le ON le.id = k.origin_entity_id
       WHERE ip.position_ref = $1 AND ip.deleted_at IS NULL
       ORDER BY ka.created_at LIMIT 200`,
      [positionRef],
    );
    return { position, klotSources: sources };
  }

  async getNetworkPosition(entityCode: string) {
    const { rows } = await this.db.query(
      `WITH positions AS (
         SELECT ip.amount, ip.currency, ft.corridor_id AS corridor,
                CASE ip.direction WHEN 'A_TO_B' THEN b.code ELSE a.code END AS creditor,
                CASE ip.direction WHEN 'A_TO_B' THEN a.code ELSE b.code END AS debtor
         FROM konektag.intercompany_positions ip
         JOIN konektag.legal_entities a ON a.id = ip.legal_entity_a_id
         JOIN konektag.legal_entities b ON b.id = ip.legal_entity_b_id
         LEFT JOIN konektag.merchant_sales ms ON ms.id = ip.source_sale_id
         LEFT JOIN konektag.financial_transactions ft ON ft.id = ms.transaction_id
         WHERE ip.status = 'OPEN' AND ip.deleted_at IS NULL
       )
       SELECT CASE WHEN creditor = $1 THEN debtor ELSE creditor END AS counterparty,
              currency, corridor,
              COALESCE(SUM(amount) FILTER (WHERE creditor = $1), 0) AS receivable,
              COALESCE(SUM(amount) FILTER (WHERE debtor = $1), 0) AS payable
       FROM positions WHERE creditor = $1 OR debtor = $1
       GROUP BY CASE WHEN creditor = $1 THEN debtor ELSE creditor END, currency, corridor
       ORDER BY counterparty, currency, corridor`,
      [entityCode],
    );
    const breakdown = rows.map(row => ({ ...row, receivable: Number(row.receivable), payable: Number(row.payable), net: Number(row.receivable) - Number(row.payable) }));
    const totalReceivable = breakdown.reduce((sum, row) => sum + row.receivable, 0);
    const totalPayable = breakdown.reduce((sum, row) => sum + row.payable, 0);
    return { legal_entity: entityCode, totalReceivable, totalPayable, net: totalReceivable - totalPayable, counterpartyBreakdown: breakdown };
  }

  private intercompanySelect(extraFields = '') {
    return `SELECT ip.position_ref AS position_id, ft.operation_id,
              source_ft.operation_id AS source_operation_id,
              CASE ip.direction WHEN 'A_TO_B' THEN b.code ELSE a.code END AS creditor_legal_entity,
              CASE ip.direction WHEN 'A_TO_B' THEN a.code ELSE b.code END AS debtor_legal_entity,
              ip.currency, ip.amount AS gross_position_amount, ft.corridor_id AS corridor,
              COALESCE(alloc.source_k_quantity, 0) AS source_k_quantity,
              ms.sale_ref AS merchant_sale_id, ip.status, ip.created_at, ip.value_date,
              ft.transaction_type AS source_event${extraFields}
       FROM konektag.intercompany_positions ip
       JOIN konektag.legal_entities a ON a.id = ip.legal_entity_a_id
       JOIN konektag.legal_entities b ON b.id = ip.legal_entity_b_id
       LEFT JOIN konektag.merchant_sales ms ON ms.id = ip.source_sale_id
       LEFT JOIN konektag.financial_transactions ft ON ft.id = ms.transaction_id
       LEFT JOIN konektag.financial_transactions source_ft ON source_ft.id = ft.source_operation_id
       LEFT JOIN LATERAL (SELECT SUM(allocated_quantity) AS source_k_quantity FROM konektag.klot_allocations WHERE transaction_id = ms.transaction_id) alloc ON true`;
  }
}

export const financeReadRepository = new FinanceReadRepository();
