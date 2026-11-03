import pool from '../../infrastructure/database/pool.ts';
import { mauticAdapter } from '../../infrastructure/adapters/mautic-adapter.ts';

export const mauticCompanySyncService = {
  async syncCompany(merchantProfileId: string): Promise<{ mauticCompanyId: number | null }> {
    const { rows: [profile] } = await pool.query(
      `SELECT * FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`,
      [merchantProfileId],
    );
    if (!profile) {
      console.error(`[MauticCompany] Profile ${merchantProfileId} not found`);
      return { mauticCompanyId: null };
    }

    // country omis : Mautic Companies utilise un champ select avec sa propre liste de pays
    const companyData: Record<string, unknown> = {
      konektag_merchant_id: profile.id,
      companyname: profile.business_name,
      companyaddress1: profile.address || '',
      companycity: profile.city || '',
      companyphone: profile.phone || '',
      companyemail: profile.email || '',
    };

    const { contact: company, created } = await mauticAdapter.upsertCompany(companyData);
    const mauticId = company.id;

    // Enregistrer mautic_company_id côté Konektag
    await pool.query(
      `UPDATE konektag.merchant_profiles SET mautic_company_id = $1, mautic_synced_at = now(), updated_at = now()
       WHERE id = $2 AND (mautic_company_id IS NULL OR mautic_company_id != $1)`,
      [mauticId, merchantProfileId],
    );

    // Associer TOUS les membres actifs à la Company
    const { rows: members } = await pool.query(
      `SELECT u.keycloak_id FROM konektag.merchant_memberships mm
       JOIN konektag.users u ON u.id = mm.user_id
       WHERE mm.merchant_profile_id = $1 AND mm.status = 'active' AND u.keycloak_id IS NOT NULL`,
      [merchantProfileId],
    );
    for (const m of members) {
      if (m.keycloak_id) {
        await mauticCompanySyncService.associateContact(m.keycloak_id, mauticId);
      }
    }

    console.log(`[MauticCompany] ${created ? 'Created' : 'Updated'} company ${mauticId} for merchant ${merchantProfileId}`);
    return { mauticCompanyId: mauticId };
  },

  async associateContact(keycloakId: string, companyId: number): Promise<void> {
    try {
      await mauticAdapter.associateContactToCompany(keycloakId, companyId);
      console.log(`[MauticCompany] Associated contact ${keycloakId} with company ${companyId}`);
    } catch (err: any) {
      console.error(`[MauticCompany] Failed to associate contact ${keycloakId}:`, err.message);
    }
  },

  async removeContactFromCompany(keycloakId: string, merchantProfileId: string): Promise<void> {
    try {
      // Résoudre le Mautic company ID depuis le merchant profile
      const { rows: [profile] } = await pool.query(
        `SELECT mautic_company_id FROM konektag.merchant_profiles WHERE id = $1 AND deleted_at IS NULL`,
        [merchantProfileId],
      );
      if (!profile?.mautic_company_id) {
        console.log(`[MauticCompany] No Mautic company for merchant ${merchantProfileId}, skipping`);
        return;
      }
      await mauticAdapter.removeContactFromCompany(keycloakId, profile.mautic_company_id);
      console.log(`[MauticCompany] Removed contact ${keycloakId} from company ${profile.mautic_company_id}`);
    } catch (err: any) {
      console.error(`[MauticCompany] Failed to remove contact:`, err.message);
    }
  },
};
