import pool from '../../infrastructure/database/pool.ts';
import { konektagFrappeSite, routeKonektagFlow, type KonektagSiteRoute } from '../shared/konektag-site.ts';

async function client() {
  return (await import('../../infrastructure/adapters/erpnext-adapter.ts')).erpnext;
}

function consentFields(consent: any): Record<string, unknown> {
  const acceptedAt = new Date(consent.accepted_at).toISOString().slice(0, 19).replace('T', ' ');
  return {
    legal_country: consent.legal_country, accepted_terms: consent.accepted, accepted_terms_at: acceptedAt,
    terms_document_id: consent.terms_document_id, terms_version: consent.terms_version, terms_hash: consent.terms_hash,
    terms_content_snapshot: consent.terms_content_snapshot, privacy_document_id: consent.privacy_document_id,
    privacy_version: consent.privacy_version, privacy_hash: consent.privacy_hash, privacy_content_snapshot: consent.privacy_content_snapshot,
  };
}

export class ErpnextContactService {
  async ensure(userId: string): Promise<string> {
    const { rows: [user] } = await pool.query(`SELECT erpnext_contact_id, username, encrypted_data FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
    if (!user) throw new Error('User not found');
    if (user.erpnext_contact_id) return user.erpnext_contact_id;
    const erpnext = await client();
    const existing = await erpnext.list('Contact', { konektag_user_id: userId }, ['name'], 1);
    const contact = existing[0] ?? await erpnext.create('Contact', { first_name: user.username, konektag_user_id: userId });
    await pool.query(`UPDATE konektag.users SET erpnext_contact_id = $1, updated_at = now() WHERE id = $2 AND erpnext_contact_id IS NULL`, [contact.name, userId]);
    await pool.query(`UPDATE konektag.legal_consents SET erpnext_contact_id = $1 WHERE user_id = $2 AND erpnext_contact_id IS NULL`, [contact.name, userId]);
    return contact.name;
  }

  async project(userId: string, fields: Record<string, unknown>): Promise<string> {
    const contactId = await this.ensure(userId);
    const erpnext = await client();
    await erpnext.update('Contact', contactId, { konektag_user_id: userId, ...fields });
    return contactId;
  }

  /**
   * UserRegistered: creates or updates the Contact and its consent on the Frappe
   * site of the residence country recorded at registration (BE -> konektag-fr).
   * The Contact is found on that site by konektag_user_id; its name is specific
   * to the site, so users.erpnext_contact_id (legacy single site) is not written.
   */
  async projectRegistration(userId: string, residenceCountry?: string): Promise<{ contactId: string; route: KonektagSiteRoute }> {
    const { rows: [user] } = await pool.query(`SELECT username, legal_country FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
    if (!user) throw new Error('User not found');
    const route = await routeKonektagFlow('registration', residenceCountry || user.legal_country || '');
    const site = konektagFrappeSite(route);
    const existing = await site.list('Contact', [['konektag_user_id', '=', userId]], ['name'], 2) as Array<{ name: string }>;
    if (existing.length > 1) throw new Error('CONTACT_AMBIGUOUS');
    const contactId = existing[0]?.name
      ?? (await site.insert('Contact', { first_name: user.username, konektag_user_id: userId }) as { name?: string })?.name;
    if (!contactId) throw new Error('CONTACT_NOT_CREATED');
    const { rows: [consent] } = await pool.query(`SELECT * FROM konektag.legal_consents WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 1`, [userId]);
    if (consent) await site.update('Contact', contactId, { konektag_user_id: userId, ...consentFields(consent) });
    return { contactId, route };
  }

  async projectConsent(userId: string): Promise<string> {
    const { rows: [consent] } = await pool.query(`SELECT * FROM konektag.legal_consents WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 1`, [userId]);
    if (!consent) return this.ensure(userId);
    return this.project(userId, consentFields(consent));
  }
}

export const erpnextContactService = new ErpnextContactService();
