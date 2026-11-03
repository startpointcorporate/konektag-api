import pool from '../../infrastructure/database/pool.ts';
import { encryptionService } from '../../infrastructure/adapters/encryption-service.ts';
import { mauticAdapter } from '../../infrastructure/adapters/mautic-adapter.ts';

export const mauticMarketingSyncService = {
  async syncProfile(payload: Record<string, unknown>): Promise<void> {
    const { userId, keycloakId } = payload as any;

    // Charger les données de base du Contact (email, firstname, lastname)
    const { rows: [user] } = await pool.query(
      `SELECT encrypted_data FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!user) {
      console.error(`[MauticMarketing] User ${userId} not found`);
      return;
    }

    let email = '';
    try {
      const decrypted = JSON.parse(encryptionService.decrypt(user.encrypted_data));
      email = decrypted.email || '';
    } catch {
      console.error(`[MauticMarketing] Failed to decrypt user ${userId}`);
      return;
    }

    if (!email) {
      console.error(`[MauticMarketing] No email for user ${userId}`);
      return;
    }

    // Construire les données marketing pour Mautic
    const contactData: Record<string, unknown> = {
      konektag_user_id: keycloakId,
      email,
      wallet_funded_once: payload.walletFundedOnce,
      k_send_count: payload.kSendCount,
      merchant_payment_count: payload.merchantPaymentCount,
      first_business_activity_at: payload.firstBusinessActivityAt,
      last_business_activity_at: payload.lastBusinessActivityAt,
      has_pending_merchant_claim: payload.hasPendingMerchantClaim,
      has_merchant_onboarding: payload.hasMerchantOnboarding,
      has_active_merchant: payload.hasActiveMerchant,
    };

    await mauticAdapter.upsert(contactData);
    console.log(`[MauticMarketing] Synced marketing profile for ${email}`);
  },
};
