import { formatMinor } from './pay/money-unit.ts';
export interface CashReceiptSnapshot {
  reference:string;amountMinor:number;refundedMinor:number;currency:string;status:string;description?:string;createdAt:string;version:number;
  merchant:{businessName:string;city?:string;slug?:string;address?:string;phone?:string;email?:string;public?:boolean};
}
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function cashReceiptHtml(sale:CashReceiptSnapshot,urls:{merchantUrl?:string;signupUrl:string},firstName?:string):string {
  const amount=(value:number)=>escape(formatMinor(value,sale.currency)+' '+sale.currency);
  const cancelled=sale.status==='CANCELLED',status=cancelled?'Annulé':sale.status==='REFUNDED'?'Remboursé':sale.status==='PARTIALLY_REFUNDED'?'Partiellement remboursé':'Espèces reçues';
  const date=new Intl.DateTimeFormat('fr-FR',{dateStyle:'long',timeStyle:'short',timeZone:'UTC'}).format(new Date(sale.createdAt));
  return `<!doctype html><html lang="fr"><body style="font-family:Arial,sans-serif;color:#172033;max-width:620px;margin:auto;padding:24px">
  <p>Bonjour${firstName?' '+escape(firstName):''},</p><h1>Reçu de ${escape(sale.merchant.businessName)}</h1>
  <p>${escape([sale.merchant.address,sale.merchant.city].filter(Boolean).join(', '))}</p>
  <p>${escape([sale.merchant.phone,sale.merchant.email].filter(Boolean).join(' · '))}</p>
  <dl><dt>Référence</dt><dd>${escape(sale.reference)}</dd><dt>Date (UTC)</dt><dd>${escape(date)}</dd>
  <dt>Mode de paiement</dt><dd>Espèces — reçues directement par le commerçant</dd>
  <dt>Montant initial</dt><dd>${amount(sale.amountMinor)}</dd><dt>Statut</dt><dd>${escape(status)}</dd>
  ${sale.refundedMinor?`<dt>Espèces remboursées</dt><dd>${amount(sale.refundedMinor)}</dd>`:''}
  <dt>Montant net enregistré</dt><dd>${amount(cancelled?0:sale.amountMinor-sale.refundedMinor)}</dd></dl>
  ${sale.description?`<p>${escape(sale.description)}</p>`:''}
  ${urls.merchantUrl?`<p><a href="${escape(urls.merchantUrl)}">Voir la fiche du commerce</a></p>`:''}
  <hr><h2>Découvrez le réseau Konektag</h2>
  <p>Retrouvez les informations de vos commerces, consultez leurs menus et catalogues disponibles, découvrez d’autres établissements et partagez vos avis.</p>
  <p><a href="${escape(urls.signupUrl)}" style="display:inline-block;padding:12px 20px;background:#D4A44A;color:#111;text-decoration:none;border-radius:6px">Créer gratuitement mon compte</a></p>
  <p>Vous recevez ce reçu sans avoir besoin d’un compte Konektag. L’inscription est facultative.</p>
  <small>Ce reçu retrace un encaissement déclaré par le commerçant. Konektag ne reçoit pas ces espèces. Version ${sale.version}.</small>
  </body></html>`;
}
