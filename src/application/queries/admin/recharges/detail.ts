import pool from '../../../../infrastructure/database/pool.ts';
import type { RechargeDetailDTO } from './dto.ts';

export const adminRechargeDetailQuery = {
  async getById(id: string): Promise<RechargeDetailDTO | null> {
    const { rows } = await pool.query(
      `SELECT
        r.id, r.recharge_name, r.keycloak_id,
        u.id AS user_id, u.keycloak_id AS user_keycloak_id, u.username AS user_name,
        u.locale AS user_locale, u.country AS user_country, u.state AS user_state,
        u.role AS user_role, u.banned_at AS user_banned_at, u.created_at AS user_created_at,
        r.requested_amount, r.requested_currency,
        r.credited_amount, r.credited_currency,
        r.payment_method, r.payment_provider, pp.name AS payment_provider_name,
        r.recharge_status, r.provider_status_detail, r.ledger_status,
        r.provider_reference, r.provider_message,
        r.internal_reference, r.country,
        r.stripe_payment_intent, r.mobile_money_operator, r.mobile_money_phone,
        r.crypto_network, r.crypto_address,
        r.created_at, r.updated_at, r.confirmed_at, r.reversed_at,
        r.anomaly
       FROM konektag.recharge_projection r
       LEFT JOIN konektag.users u ON u.keycloak_id = r.keycloak_id
       LEFT JOIN konektag.payment_providers pp ON pp.code = r.payment_provider
       WHERE (r.id = $1 OR r.recharge_name = $1) AND r.deleted_at IS NULL`,
      [id],
    );

    if (rows.length === 0) return null;
    const r = rows[0];

    let user: RechargeDetailDTO['user'] = null;
    if (r.user_id) {
      user = {
        id: r.user_id,
        keycloakId: r.user_keycloak_id,
        username: r.user_name,
        locale: r.user_locale,
        country: r.user_country,
        state: r.user_state,
        role: r.user_role,
        bannedAt: r.user_banned_at,
        createdAt: r.user_created_at,
      };
    }

    const { rows: [bal] } = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE 0 END), 0)
        AS balance
       FROM konektag.ledger_entries
       WHERE client_id = $1`,
      [r.keycloak_id],
    );
    const walletBalance = bal ? Number(bal.balance) : null;

    const { rows: ledgerRows } = await pool.query(
      `SELECT id, entry_side, amount, currency, description, is_reversal, reversed_entry_id, created_at
       FROM konektag.ledger_entries
       WHERE document_ref = $1
       ORDER BY created_at ASC`,
      [r.recharge_name],
    );
    const ledgerEntries = ledgerRows.map(e => ({
      id: e.id, entrySide: e.entry_side, amount: Number(e.amount),
      currency: e.currency, description: e.description,
      isReversal: e.is_reversal, reversedEntryId: e.reversed_entry_id, createdAt: e.created_at,
    }));

    const { rows: eventRows } = await pool.query(
      `SELECT id, from_status, to_status, changed_by, reason, created_at
       FROM konektag.recharge_events
       WHERE recharge_id = $1
       ORDER BY created_at ASC`,
      [r.id],
    );
    const events = eventRows.map(e => ({
      id: e.id, fromStatus: e.from_status, toStatus: e.to_status,
      changedBy: e.changed_by, reason: e.reason, createdAt: e.created_at,
    }));

    const { rows: actionRows } = await pool.query(
      `SELECT id, action_type, reason, created_at
       FROM konektag.admin_actions
       WHERE target_type = 'recharge' AND target_id = $1
       ORDER BY created_at DESC`,
      [r.id],
    );
    const adminActions = actionRows.map(a => ({
      id: a.id, actionType: a.action_type, reason: a.reason, createdAt: a.created_at,
    }));

    return {
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
      providerMessage: r.provider_message,
      internalReference: r.internal_reference || r.recharge_name,
      stripePaymentIntent: r.stripe_payment_intent,
      mobileMoneyOperator: r.mobile_money_operator,
      mobileMoneyPhone: r.mobile_money_phone,
      cryptoNetwork: r.crypto_network,
      cryptoAddress: r.crypto_address,
      country: r.country,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      confirmedAt: r.confirmed_at,
      reversedAt: r.reversed_at,
      anomaly: r.anomaly,
      hasAnomaly: !!r.anomaly,
      user,
      walletBalance,
      ledgerEntries,
      events,
      adminActions,
    };
  },
};
