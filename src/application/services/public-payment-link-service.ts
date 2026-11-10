import pool from '../../infrastructure/database/pool.ts';

/** Consultation projection of a network link: the beneficiary is a Frappe site, named by its network. */
export async function getPublicPaymentLink(slug: string) {
  const { rows: [row] } = await pool.query(
    `SELECT nl.beneficiary_name AS business_name, ci.amount, ci.currency, ci.quantity_k,
            ci.service_description, ci.reference, ci.expiration, ci.status
       FROM konektag.checkout_intents ci
       JOIN konektag.link_pay_network_links nl ON nl.checkout_intent_id = ci.id
      WHERE ci.public_id = $1 AND ci.source_type = 'payment_link'`, [slug]);
  if (!row) return null;
  if (row.status === 'CONSUMED') return { status: 'Used' as const };
  if (row.status === 'EXPIRED' || !row.expiration
      || !Number.isFinite(new Date(row.expiration).getTime()) || new Date(row.expiration).getTime() <= Date.now()) {
    return { status: 'Expired' as const };
  }
  if (row.status !== 'ISSUED') return null;
  return {
    status: 'Active' as const,
    etablissement: row.business_name || 'Commerçant',
    amount: Number(row.amount), currency: row.currency as string, quantityK: Number(row.quantity_k),
    description: row.service_description || '', reference: row.reference || '', expires_at: row.expiration,
  };
}
