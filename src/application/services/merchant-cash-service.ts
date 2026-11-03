import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../infrastructure/database/pool.ts';
import { encryptionService } from '../../infrastructure/adapters/encryption-service.ts';
import { requireCanonicalCurrency } from './operation-currency-service.ts';
import { CashError, cashAdjustment, cashAmount, cashContact, cashKey, cashText, cashUuid } from '../../domain/merchant-cash.ts';

type Db = Pick<PoolClient,'query'>;
const hash = (value:unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function requireCashMerchant(db:Db, merchantId:string, actorId:string, writing=false):Promise<any> {
  cashUuid(merchantId);
  const {rows:[merchant]}=await db.query(`SELECT mp.id,mp.business_name,mp.country,mp.city,mp.slug,mp.address,mp.phone,mp.email,mp.status,
    (mp.status IN ('Published','Referenced') OR EXISTS(SELECT 1 FROM konektag.merchant_n2_publication_snapshots n2 WHERE n2.merchant_profile_id=mp.id)) AS is_public
    FROM konektag.merchant_profiles mp WHERE mp.id=$1 AND mp.deleted_at IS NULL AND
    (mp.user_id=$2 OR EXISTS(SELECT 1 FROM konektag.merchant_memberships mm
      WHERE mm.merchant_profile_id=mp.id AND mm.user_id=$2 AND mm.status='active' AND mm.removed_at IS NULL AND mm.role IN ('owner','manager')))`,[merchantId,actorId]);
  if(!merchant) throw new CashError('CASH_ACCESS_DENIED',403);
  if(writing&&merchant.status==='Suspended') throw new CashError('CASH_MERCHANT_SUSPENDED',403);
  return merchant;
}
export function cashSaleView(row:any) {
  return {id:row.id,reference:row.reference,merchantProfileId:row.merchant_profile_id,amountMinor:Number(row.amount_minor),currency:row.currency,
    refundedMinor:Number(row.refunded_minor),netMinor:row.status==='CANCELLED'?0:Number(row.amount_minor)-Number(row.refunded_minor),
    status:row.status,description:row.description,createdBy:row.created_by,createdAt:row.created_at,version:row.version,hasEmail:row.has_email,
    receipt:row.receipt_id?{id:row.receipt_id,status:row.receipt_status,saleVersion:row.receipt_version,sentAt:row.receipt_sent_at,lastError:row.receipt_error}:null};
}
async function readCash(db:Db,id:string,merchantId:string) {
  const {rows:[row]}=await db.query(`SELECT s.*,r.id AS receipt_id,r.status AS receipt_status,r.sale_version AS receipt_version,r.sent_at AS receipt_sent_at,r.last_error AS receipt_error
    FROM konektag.merchant_cash_sales s LEFT JOIN LATERAL(SELECT * FROM konektag.merchant_cash_receipts WHERE sale_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
    WHERE s.id=$1 AND s.merchant_profile_id=$2`,[id,merchantId]);
  if(!row) throw new CashError('CASH_SALE_NOT_FOUND',404);
  return row;
}
async function queueReceipt(db:Db,sale:any,actorId:string,key:string) {
  if(!sale.has_email) return null;
  const snapshot={reference:sale.reference,amountMinor:Number(sale.amount_minor),refundedMinor:Number(sale.refunded_minor),currency:sale.currency,
    status:sale.status,description:sale.description,createdAt:sale.created_at,version:sale.version,merchant:sale.merchant_snapshot};
  const {rows:[receipt]}=await db.query(`INSERT INTO konektag.merchant_cash_receipts(sale_id,requested_by,request_key,sale_version,snapshot)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(sale_id,request_key) DO NOTHING RETURNING id`,[sale.id,actorId,key,sale.version,JSON.stringify(snapshot)]);
  if(!receipt) return null;
  await db.query(`INSERT INTO konektag.outbox_events(correlation_id,aggregate_type,aggregate_id,event_type,event_version,payload)
    VALUES($1,'MerchantCashReceipt',$2,'MerchantCashReceiptRequested',1,$3::jsonb)`,[crypto.randomUUID(),receipt.id,JSON.stringify({receiptId:receipt.id})]);
  return receipt.id;
}
async function transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try{await client.query('BEGIN');const result=await action(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function recordCashSale(actorId:string,input:Record<string,unknown>,requestKey:unknown) {
  const merchantId=cashUuid(input.merchantProfileId),key=cashKey(requestKey);
  return transaction(async db=>{
    const merchant=await requireCashMerchant(db,merchantId,actorId,true);
    let currency:string;try{currency=requireCanonicalCurrency(merchant.country,input.currency);}catch{throw new CashError('CASH_CURRENCY_UNAVAILABLE');}
    const amountMinor=cashAmount(input.amount,currency),description=cashText(input.description,1000),contact=cashContact(input);
    const requestHash=hash({actorId,amountMinor,currency,description:description??null,contact});
    const encrypted=Object.values(contact).some(Boolean)?encryptionService.encrypt(JSON.stringify(contact)):null;
    const merchantSnapshot={businessName:merchant.business_name,city:merchant.city,slug:merchant.slug,address:merchant.address,phone:merchant.phone,email:merchant.email,
      public:merchant.is_public&&merchant.status!=='Suspended'};
    const {rows:[created]}=await db.query(`INSERT INTO konektag.merchant_cash_sales(reference,merchant_profile_id,created_by,request_key,request_hash,amount_minor,currency,description,customer_encrypted,has_email,merchant_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(merchant_profile_id,request_key) DO NOTHING RETURNING *`,
      ['CASH-'+crypto.randomUUID().toUpperCase(),merchantId,actorId,key,requestHash,amountMinor,currency,description??null,encrypted,!!contact.email,JSON.stringify(merchantSnapshot)]);
    if(!created){
      const {rows:[existing]}=await db.query(`SELECT * FROM konektag.merchant_cash_sales WHERE merchant_profile_id=$1 AND request_key=$2`,[merchantId,key]);
      if(!existing||existing.request_hash!==requestHash)throw new CashError('CASH_IDEMPOTENCY_CONFLICT',409);
      return {sale:cashSaleView(await readCash(db,existing.id,merchantId)),replayed:true};
    }
    await queueReceipt(db,created,actorId,'initial');
    return {sale:cashSaleView(await readCash(db,created.id,merchantId)),replayed:false};
  });
}
export async function adjustCashSale(actorId:string,merchantId:string,saleId:string,input:Record<string,unknown>,requestKey:unknown) {
  cashUuid(saleId);cashUuid(merchantId);const key=cashKey(requestKey),reason=cashText(input.reason,1000);
  if(!reason) throw new CashError('CASH_REASON_REQUIRED');
  return transaction(async db=>{
    await requireCashMerchant(db,merchantId,actorId,true);
    const {rows:[sale]}=await db.query(`SELECT * FROM konektag.merchant_cash_sales WHERE id=$1 AND merchant_profile_id=$2 FOR UPDATE`,[saleId,merchantId]);
    if(!sale)throw new CashError('CASH_SALE_NOT_FOUND',404);
    const requestHash=hash({actorId,kind:input.kind,amount:input.amount??null,reason,expectedVersion:input.expectedVersion});
    const {rows:[existing]}=await db.query(`SELECT request_hash FROM konektag.merchant_cash_adjustments WHERE sale_id=$1 AND request_key=$2`,[saleId,key]);
    if(existing){if(existing.request_hash!==requestHash)throw new CashError('CASH_IDEMPOTENCY_CONFLICT',409);return cashSaleView(await readCash(db,saleId,merchantId));}
    const adjustment=cashAdjustment(cashSaleView(sale),input.kind,input.amount,sale.currency,input.expectedVersion);
    const {rows:[event]}=await db.query(`INSERT INTO konektag.merchant_cash_adjustments(sale_id,actor_user_id,kind,amount_minor,reason,request_key,request_hash,from_version,to_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[saleId,actorId,input.kind,adjustment.amountMinor,reason,key,requestHash,sale.version,sale.version+1]);
    const {rows:[updated]}=await db.query(`UPDATE konektag.merchant_cash_sales SET refunded_minor=$2,status=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[saleId,adjustment.refundedMinor,adjustment.status]);
    await queueReceipt(db,updated,actorId,'adjustment:'+event.id);
    return cashSaleView(await readCash(db,saleId,merchantId));
  });
}
export async function resendCashReceipt(actorId:string,merchantId:string,saleId:string,requestKey:unknown) {
  cashUuid(saleId);const key=hash(cashKey(requestKey));
  return transaction(async db=>{
    await requireCashMerchant(db,merchantId,actorId);
    // Serialize manual resend requests to avoid accidental bursts from a double click.
    const {rows:[sale]}=await db.query(`SELECT * FROM konektag.merchant_cash_sales WHERE id=$1 AND merchant_profile_id=$2 FOR UPDATE`,[saleId,merchantId]);
    if(!sale)throw new CashError('CASH_SALE_NOT_FOUND',404);
    if(!sale.has_email)throw new CashError('CASH_NO_RECEIPT_EMAIL');
    const {rows:[existing]}=await db.query(`SELECT id FROM konektag.merchant_cash_receipts WHERE sale_id=$1 AND request_key=$2`,[saleId,'resend:'+key]);
    if(existing)return {receiptId:existing.id};
    const {rows:[recent]}=await db.query(`SELECT id FROM konektag.merchant_cash_receipts WHERE sale_id=$1 AND created_at>now()-interval '1 minute' LIMIT 1`,[saleId]);
    if(recent)throw new CashError('CASH_RECEIPT_RETRY_LATER',429);
    return {receiptId:await queueReceipt(db,sale,actorId,'resend:'+key)};
  });
}
export async function listCashSales(actorId:string,merchantId:string,page=1) {
  await requireCashMerchant(pool,merchantId,actorId);
  const {rows}=await pool.query(`SELECT s.*,count(*) OVER() AS total_count,r.id AS receipt_id,r.status AS receipt_status,r.sale_version AS receipt_version,r.sent_at AS receipt_sent_at,r.last_error AS receipt_error
    FROM konektag.merchant_cash_sales s LEFT JOIN LATERAL(SELECT * FROM konektag.merchant_cash_receipts WHERE sale_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
    WHERE s.merchant_profile_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 25 OFFSET $2`,[merchantId,(page-1)*25]);
  return {data:rows.map(cashSaleView),total:Number(rows[0]?.total_count||0),page,pageSize:25};
}
export async function cashSaleDetails(actorId:string,merchantId:string,saleId:string) {
  cashUuid(saleId);await requireCashMerchant(pool,merchantId,actorId);
  const sale=await readCash(pool,saleId,merchantId);
  const {rows:adjustments}=await pool.query(`SELECT id,actor_user_id,kind,amount_minor,reason,from_version,to_version,created_at FROM konektag.merchant_cash_adjustments WHERE sale_id=$1 ORDER BY to_version`,[saleId]);
  const {rows:receipts}=await pool.query(`SELECT id,sale_version,status,attempts,sent_at,last_error,created_at FROM konektag.merchant_cash_receipts WHERE sale_id=$1 ORDER BY created_at DESC,id DESC`,[saleId]);
  return {sale:cashSaleView(sale),adjustments:adjustments.map(row=>({...row,amount_minor:Number(row.amount_minor)})),receipts};
}
