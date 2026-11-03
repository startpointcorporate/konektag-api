import pool from '../../infrastructure/database/pool.ts';
import { encryptionService } from '../../infrastructure/adapters/encryption-service.ts';
import { mauticAdapter } from '../../infrastructure/adapters/mautic-adapter.ts';
import type { MauticContactData } from '../../infrastructure/adapters/mautic-adapter.ts';

export const mauticContactSyncService = {
  /**
   * Synchroniser un utilisateur vers Mautic.
   * Cette méthode est appelée par l'outbox dispatcher, jamais depuis le navigateur.
   */
  async syncUser(userId: string, keycloakId: string): Promise<{ mauticId: number | null }> {
    // Charger les données utilisateur depuis PostgreSQL
    const { rows: [user] } = await pool.query(
      `SELECT id, keycloak_id, username, email_hash, phone_hash, locale, country,
              encrypted_data, marketing_opt_in, marketing_opt_in_at, marketing_opt_out_at
       FROM konektag.users
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );

    if (!user) {
      console.error(`[MauticSync] User ${userId} not found`);
      return { mauticId: null };
    }

    // Déchiffrer les données PII
    let email = '';
    let firstname = '';
    let lastname = '';
    try {
      const decrypted = JSON.parse(encryptionService.decrypt(user.encrypted_data));
      email = decrypted.email || '';
      firstname = decrypted.firstName || decrypted.firstname || '';
      lastname = decrypted.lastName || decrypted.lastname || '';
    } catch {
      console.error(`[MauticSync] Failed to decrypt user data for ${userId}`);
      return { mauticId: null };
    }

    if (!email) {
      console.error(`[MauticSync] No email for user ${userId}`);
      return { mauticId: null };
    }

    // Construire les données Mautic
    const contactData: MauticContactData = {
      konektag_user_id: keycloakId,
      email,
      firstname,
      lastname,
      preferred_locale: user.locale || 'fr',
      country: user.country || '',
      konektag_marketing_opt_in: user.marketing_opt_in || false,
    };

    // Upsert dans Mautic
    const { contact, created } = await mauticAdapter.upsert(contactData);
    const mauticId = contact.id;

    // Enregistrer mautic_contact_id côté Konektag
    await pool.query(
      `UPDATE konektag.users SET mautic_contact_id = $1, updated_at = now()
       WHERE id = $2 AND (mautic_contact_id IS NULL OR mautic_contact_id != $1)`,
      [mauticId, userId],
    );

    console.log(
      `[MauticSync] ${created ? 'Created' : 'Updated'} contact ${mauticId} for user ${userId} (${email})`,
    );

    return { mauticId };
  },

  /**
   * Synchroniser le consentement marketing seulement (opt-in/opt-out).
   * Plus léger qu'un syncUser complet.
   */
  async syncMarketingConsent(
    userId: string,
    keycloakId: string,
    optIn: boolean,
  ): Promise<void> {
    // Chercher le mautic_contact_id enregistré
    const { rows: [user] } = await pool.query(
      `SELECT mautic_contact_id FROM konektag.users
       WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );

    let mauticId = user?.mautic_contact_id;

    if (!mauticId) {
      // Pas encore synchronisé — faire un sync complet
      await mauticContactSyncService.syncUser(userId, keycloakId);
      return;
    }

    // Mise à jour légère du seul champ consentement
    await mauticAdapter.update(mauticId, {
      konektag_marketing_opt_in: optIn,
    });

    console.log(`[MauticSync] Updated marketing consent to ${optIn} for contact ${mauticId}`);
  },
};
