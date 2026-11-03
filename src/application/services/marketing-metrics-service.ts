import pool from '../../infrastructure/database/pool.ts';
import { getCorrelationId } from '../../infrastructure/correlation-id.ts';

export interface MarketingMetricsSnapshot {
  walletFundedOnce: boolean;
  kSendCount: number;
  merchantPaymentCount: number;
  firstBusinessActivityAt: string | null;
  lastBusinessActivityAt: string | null;
}

export interface MarketingProfileState {
  metrics: MarketingMetricsSnapshot;
  hasPendingMerchantClaim: boolean;
  hasMerchantOnboarding: boolean;
  hasActiveMerchant: boolean;
}

/**
 * Service centralisé de calcul de la projection marketing utilisateur.
 *
 * Règles :
 * - Recalcule TOUJOURS depuis les tables sources (idempotent)
 * - Ne publie UserMarketingProfileUpdated que si l'état a changé
 * - Toute la logique marketing est ici, pas dans les services métier
 */
export const marketingMetricsService = {
  /**
   * Recalculer la projection marketing pour un utilisateur.
   * À appeler depuis les points de déclenchement métier uniquement.
   */
  async refresh(userId: string, keycloakId: string): Promise<void> {
    // Recalcul via la fonction SQL (idempotent)
    await pool.query('SELECT konektag.refresh_user_marketing_metrics($1)', [userId]);

    // Lire l'état recalulé
    const { rows: [metrics] } = await pool.query(
      `SELECT wallet_funded_once, k_send_count, merchant_payment_count,
              first_business_activity_at, last_business_activity_at
       FROM konektag.user_marketing_metrics WHERE user_id = $1`,
      [userId],
    );

    if (!metrics) {
      console.log(`[MarketingMetrics] No metrics row for user ${userId}, skipping`);
      return;
    }

    // Calculer les indicateurs relationnels
    const { rows: [rels] } = await pool.query(
      `SELECT
         -- has_pending_merchant_claim : au moins un claim en attente
         EXISTS(SELECT 1 FROM konektag.merchant_claims WHERE user_id = $1 AND status = 'pending') AS has_pending_claim,

         -- has_merchant_onboarding : membership active owner/manager
         -- + claim approuvé + commerce pas encore actif
         EXISTS(
           SELECT 1 FROM konektag.merchant_memberships mm
           JOIN konektag.merchant_profiles mp ON mp.id = mm.merchant_profile_id
           WHERE mm.user_id = $1 AND mm.status = 'active' AND mm.role IN ('owner','manager')
             AND EXISTS(
               SELECT 1 FROM konektag.merchant_claims mc
               WHERE mc.merchant_profile_id = mp.id AND mc.user_id = $1 AND mc.status = 'approved'
             )
             AND NOT EXISTS(  -- pas encore actif (pas de paiement reçu)
               SELECT 1 FROM konektag.ledger_entries le
               JOIN konektag.parties p ON p.id = le.party_id
               WHERE le.account_code = '2000' AND le.entry_side = 'credit'
                 AND p.keycloak_id = (SELECT u2.keycloak_id FROM konektag.users u2 WHERE u2.id = mp.user_id LIMIT 1)
             )
         ) AS has_onboarding,

         -- has_active_merchant : membership active owner/manager
         -- + le marchand a reçu au moins un paiement (via merchant_profile_id)
         EXISTS(
           SELECT 1 FROM konektag.merchant_memberships mm
           WHERE mm.user_id = $1 AND mm.status = 'active' AND mm.role IN ('owner','manager')
             AND EXISTS(
               SELECT 1 FROM konektag.financial_transactions ft
               WHERE ft.merchant_profile_id = mm.merchant_profile_id
                 AND ft.transaction_type = 'qr_payment'
                 AND ft.status = 'completed'
             )
         ) AS has_active`,
      [userId],
    );

    const newState: MarketingProfileState = {
      metrics: {
        walletFundedOnce: metrics.wallet_funded_once,
        kSendCount: metrics.k_send_count,
        merchantPaymentCount: metrics.merchant_payment_count,
        firstBusinessActivityAt: metrics.first_business_activity_at?.toISOString?.() ?? metrics.first_business_activity_at ?? null,
        lastBusinessActivityAt: metrics.last_business_activity_at?.toISOString?.() ?? metrics.last_business_activity_at ?? null,
      },
      hasPendingMerchantClaim: rels?.has_pending_claim ?? false,
      hasMerchantOnboarding: rels?.has_onboarding ?? false,
      hasActiveMerchant: rels?.has_active ?? false,
    };

    // Comparer avec l'état stocké pour éviter les publications inutiles
    const { rows: [prev] } = await pool.query(
      `SELECT payload FROM konektag.outbox_events
       WHERE aggregate_type = 'User' AND aggregate_id = $1 AND event_type = 'UserMarketingProfileUpdated' AND processed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );

    let prevState: MarketingProfileState | null = null;
    if (prev?.payload) {
      try {
        prevState = typeof prev.payload === 'string' ? JSON.parse(prev.payload) : prev.payload;
      } catch {}
    }

    if (prevState && newState && !marketingMetricsService._hasChanged(newState, prevState)) {
      return; // rien n'a changé, pas d'événement
    }

    // Publier dans l'outbox
    const correlationId = getCorrelationId();
    await pool.query(
      `INSERT INTO konektag.outbox_events
       (correlation_id, aggregate_type, aggregate_id, event_type, event_version, payload)
       VALUES ($1, 'User', $2, 'UserMarketingProfileUpdated', 1, $3)`,
      [correlationId, userId, JSON.stringify({
        userId,
        keycloakId,
        ...newState.metrics,
        hasPendingMerchantClaim: newState.hasPendingMerchantClaim,
        hasMerchantOnboarding: newState.hasMerchantOnboarding,
        hasActiveMerchant: newState.hasActiveMerchant,
      })],
    );
  },

  _hasChanged(a: MarketingProfileState, b: MarketingProfileState): boolean {
    if (!a || !b || !a.metrics || !b.metrics) return true;
    if (a.metrics.walletFundedOnce !== b.metrics.walletFundedOnce) return true;
    if (a.metrics.kSendCount !== b.metrics.kSendCount) return true;
    if (a.metrics.merchantPaymentCount !== b.metrics.merchantPaymentCount) return true;
    if (a.metrics.firstBusinessActivityAt !== b.metrics.firstBusinessActivityAt) return true;
    if (a.metrics.lastBusinessActivityAt !== b.metrics.lastBusinessActivityAt) return true;
    if (a.hasPendingMerchantClaim !== b.hasPendingMerchantClaim) return true;
    if (a.hasMerchantOnboarding !== b.hasMerchantOnboarding) return true;
    if (a.hasActiveMerchant !== b.hasActiveMerchant) return true;
    return false;
  },
};
