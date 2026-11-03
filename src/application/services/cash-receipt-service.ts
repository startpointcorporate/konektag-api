import pool from '../../infrastructure/database/pool.ts';
import { encryptionService } from '../../infrastructure/adapters/encryption-service.ts';
import { emailService } from './resend-service.ts';
import { cashReceiptHtml } from './cash-receipt-template.ts';
import { marketplaceMerchantPath } from '../shared/marketplace/slug.ts';

/** Dispatch after the sale transaction committed. The event contains IDs only. */
export async function deliverCashReceipt(receiptId:string):Promise<void> {
  const {rows:[job]}=await pool.query(`UPDATE konektag.merchant_cash_receipts SET lease_until=now()+interval '5 minutes',attempts=attempts+1
    WHERE id=$1 AND status IN ('PENDING','FAILED') AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,[receiptId]);
  if(!job){
    const {rows:[existing]}=await pool.query(`SELECT status FROM konektag.merchant_cash_receipts WHERE id=$1`,[receiptId]);
    if(!existing||['SENT','SUPERSEDED'].includes(existing.status))return;
    throw new Error('CASH_RECEIPT_BUSY');
  }
  try {
    const {rows:[sale]}=await pool.query(`SELECT customer_encrypted,version FROM konektag.merchant_cash_sales WHERE id=$1`,[job.sale_id]);
    if(!sale)throw new Error('CASH_RECEIPT_SALE_MISSING');
    if(sale.version!==job.sale_version){
      await pool.query(`UPDATE konektag.merchant_cash_receipts SET status='SUPERSEDED',lease_until=NULL WHERE id=$1`,[receiptId]);return;
    }
    const contact=JSON.parse(encryptionService.decrypt(sale.customer_encrypted));
    if(!contact.email)throw new Error('CASH_RECEIPT_EMAIL_MISSING');
    const site=process.env.PUBLIC_SITE_URL;
    if(!site||!/^https?:\/\//.test(site))throw new Error('CASH_RECEIPT_SITE_URL_REQUIRED');
    const base=new URL(site);
    const merchant=job.snapshot.merchant;
    const merchantUrl=merchant.public&&merchant.city&&merchant.slug?new URL(marketplaceMerchantPath('fr',merchant.city,merchant.slug),base).href:undefined;
    const accepted=await emailService.send({to:contact.email,subject:`${job.sale_version>1?'Mise à jour du reçu':'Votre reçu'} — ${merchant.businessName}`,
      html:cashReceiptHtml(job.snapshot,{merchantUrl,signupUrl:new URL('/fr/onboarding/',base).href},contact.firstName),idempotencyKey:'cash-receipt/'+receiptId});
    if(!accepted)throw new Error('CASH_RECEIPT_SEND_FAILED');
    await pool.query(`UPDATE konektag.merchant_cash_receipts SET status='SENT',sent_at=now(),last_error=NULL,lease_until=NULL WHERE id=$1`,[receiptId]);
  } catch(error) {
    await pool.query(`UPDATE konektag.merchant_cash_receipts SET status='FAILED',last_error='CASH_RECEIPT_DELIVERY_FAILED',lease_until=NULL WHERE id=$1`,[receiptId]);
    // Never include the recipient or provider response in outbox logs.
    throw new Error('CASH_RECEIPT_DELIVERY_FAILED');
  }
}
