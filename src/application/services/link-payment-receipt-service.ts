import pool from '../../infrastructure/database/pool.ts';
import { emailService } from './resend-service.ts';
import { formatMinor } from './pay/money-unit.ts';

export interface LinkPaymentSummary {
  merchantName: string;
  amount: number;
  currency: string;
  quantityK: number;
  reference: string;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

export function linkPaymentReceiptHtml(payment: LinkPaymentSummary, paidAt: string | Date,
  historyUrl: string, firstName?: string): string {
  const date = new Intl.DateTimeFormat('fr-FR', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    second: '2-digit', timeZoneName: 'short',
  }).format(new Date(paidAt));
  return `<p>Bonjour${firstName ? ' ' + escapeHtml(firstName) : ''},</p>
<h1>Paiement confirmé</h1>
<p>Votre paiement auprès de ${escapeHtml(payment.merchantName)} a bien été effectué.</p>
<dl><dt>Montant :</dt><dd>${formatMinor(payment.amount, payment.currency)} ${escapeHtml(payment.currency)}</dd>
<dt>Points K utilisés :</dt><dd>${payment.quantityK.toLocaleString('fr-FR')} K</dd>
<dt>Référence :</dt><dd>${escapeHtml(payment.reference)}</dd>
<dt>Date :</dt><dd>${escapeHtml(date)}</dd><dt>Statut :</dt><dd>Payé</dd></dl>
<p>Vous pouvez retrouver cette opération dans votre compte Konektag.</p>
<p><a href="${escapeHtml(historyUrl)}" style="display:inline-block;padding:12px 24px;border-radius:6px;background:#D4A44A;color:#0B0F19;text-decoration:none">Voir mon historique</a></p>
<p>Konektag</p>`;
}

/** Optional receipt, strictly after payment commit. No payment state is written here. */
export async function sendLinkPaymentReceipt(input: {
  email?: string; slug: string; userId: string; firstName?: string; locale?: string;
  payment: LinkPaymentSummary; origin: string;
}): Promise<boolean> {
  if (!input.email) return false;
  try {
    const { rows: [paid] } = await pool.query(
      `SELECT consumed_at FROM konektag.checkout_intents
       WHERE public_id=$1 AND payer_user_id=$2 AND source_type='payment_link' AND status='CONSUMED'`,
      [input.slug, input.userId]);
    if (!paid?.consumed_at) throw new Error('LINK_RECEIPT_PAYMENT_DATE_UNAVAILABLE');
    const locale = input.locale === 'en' ? 'en' : 'fr';
    const historyUrl = new URL(`/${locale}/account/history/`, input.origin).href;
    return await emailService.send({ to: input.email, subject: 'Confirmation de paiement — Konektag',
      html: linkPaymentReceiptHtml(input.payment, paid.consumed_at, historyUrl, input.firstName) });
  } catch {
    console.error('[LinkPaymentReceipt] Receipt unavailable after confirmed payment');
    return false;
  }
}
