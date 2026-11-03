import pool from '../../infrastructure/database/pool.ts';

async function client() {
  return (await import('../../infrastructure/adapters/erpnext-adapter.ts')).erpnext;
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

  async projectConsent(userId: string): Promise<string> {
    const { rows: [consent] } = await pool.query(`SELECT * FROM konektag.legal_consents WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 1`, [userId]);
    if (!consent) return this.ensure(userId);
    const acceptedAt = new Date(consent.accepted_at).toISOString().slice(0, 19).replace('T', ' ');
    return this.project(userId, {
      legal_country: consent.legal_country, accepted_terms: consent.accepted, accepted_terms_at: acceptedAt,
      terms_document_id: consent.terms_document_id, terms_version: consent.terms_version, terms_hash: consent.terms_hash,
      terms_content_snapshot: consent.terms_content_snapshot, privacy_document_id: consent.privacy_document_id,
      privacy_version: consent.privacy_version, privacy_hash: consent.privacy_hash, privacy_content_snapshot: consent.privacy_content_snapshot,
    });
  }
}

export const erpnextContactService = new ErpnextContactService();
