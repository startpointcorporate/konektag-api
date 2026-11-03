import pool from '../../infrastructure/database/pool.ts';
import { emailService } from './resend-service.ts';
import { linkPaymentReceiptHtml, type LinkPaymentSummary } from './link-payment-receipt-service.ts';

export async function sendQrPaymentReceipt(input:{
  email?:string; qrCodeName:string; userId:string; firstName?:string; locale?:string;
  payment:LinkPaymentSummary; origin:string;
}):Promise<boolean>{
  if(!input.email)return false;
  try{
    const {rows:[paid]}=await pool.query(`SELECT consumed_at FROM konektag.checkout_intents
      WHERE public_id=$1 AND payer_user_id=$2 AND source_type='qr' AND status='CONSUMED'`,[input.qrCodeName,input.userId]);
    if(!paid?.consumed_at)throw new Error('QR_RECEIPT_PAYMENT_DATE_UNAVAILABLE');
    const locale=input.locale==='en'?'en':'fr';
    const historyUrl=new URL(`/${locale}/account/history/`,input.origin).href;
    return await emailService.send({to:input.email,subject:'Confirmation de paiement — Konektag',
      html:linkPaymentReceiptHtml(input.payment,paid.consumed_at,historyUrl,input.firstName)});
  }catch{console.error('[QrPaymentReceipt] Receipt unavailable after confirmed payment');return false;}
}
