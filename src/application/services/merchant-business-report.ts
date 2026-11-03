import pool from '../../infrastructure/database/pool.ts';
import { requireCashMerchant } from './merchant-cash-service.ts';
import { requireCanonicalCurrency } from './operation-currency-service.ts';
import { minorDigits } from './pay/money-unit.ts';
import { CashError } from '../../domain/merchant-cash.ts';

// This is a read projection only. Cash never enters merchant_sales, ledger or settlements.
// Refunds follow the sale's creation-date cohort, including later corrections.
export const BUSINESS_SALES_CTE = `WITH sources AS (
 SELECT s.id,s.reference,s.created_at,s.currency,'CASH'::text AS mode,s.status,
   CASE WHEN s.status='CANCELLED' THEN 0 ELSE s.amount_minor END::numeric AS gross_minor,
   s.refunded_minor::numeric AS refund_minor,0::numeric AS commission_minor,
   CASE WHEN s.status='CANCELLED' THEN 0 ELSE s.amount_minor-s.refunded_minor END::numeric AS net_minor,
   CASE WHEN s.status='CANCELLED' THEN 0 ELSE 1 END AS counted
 FROM konektag.merchant_cash_sales s WHERE s.merchant_profile_id=$1 AND s.created_at>now()-$2::interval
 UNION ALL
 SELECT s.id,s.sale_ref::text,s.created_at,s.currency,
   CASE WHEN c.id IS NULL THEN 'ONLINE' ELSE 'POINTS_K' END,
   CASE WHEN COALESCE(r.quantity,0)>=c.quantity THEN 'REFUNDED'
        WHEN COALESCE(r.quantity,0)>0 THEN 'PARTIALLY_REFUNDED' ELSE 'RECORDED' END,
   round(s.gross_amount*f.factor),
   CASE WHEN c.value_basis_version=2 THEN round(c.transaction_amount_minor*COALESCE(r.quantity,0)/NULLIF(c.quantity,0))
        ELSE round(COALESCE(r.value,0)*f.factor) END,
   round(s.commission_amount*f.factor),
   greatest(0,round(s.net_amount*f.factor)-CASE WHEN c.value_basis_version=2
     THEN round(c.transaction_amount_minor*COALESCE(r.quantity,0)/NULLIF(c.quantity,0)) ELSE round(COALESCE(r.value,0)*f.factor) END),1
 FROM konektag.merchant_sales s
 LEFT JOIN konektag.points_merchant_consumptions c ON c.monetary_transaction_id=s.transaction_id AND c.merchant_profile_id=s.merchant_profile_id
 LEFT JOIN LATERAL(SELECT sum(quantity) AS quantity,sum(merchant_value) AS value FROM konektag.points_merchant_refunds WHERE consumption_id=c.id) r ON true
 CROSS JOIN LATERAL(SELECT CASE WHEN s.amount_unit='MINOR' OR c.value_basis_version=2 OR s.currency IN ('XOF','XAF','GNF','RWF','UGX') THEN 1 ELSE 100 END::numeric AS factor) f
 WHERE s.merchant_profile_id=$1 AND s.deleted_at IS NULL AND s.created_at>now()-$2::interval
)`;
const intervals:Record<string,string>={'7d':'7 days','30d':'30 days','90d':'90 days','12m':'365 days'};
function safe(value:unknown) { const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new CashError('BUSINESS_AMOUNT_OUT_OF_RANGE',422);return n; }
export async function merchantBusinessReport(actorId:string,merchantId:string,period='30d',requestedCurrency?:string|null) {
 const merchant=await requireCashMerchant(pool,merchantId,actorId);
 const interval=intervals[period]||intervals['30d'];if(!intervals[period])period='30d';
 const {rows}=await pool.query(BUSINESS_SALES_CTE+` SELECT currency,mode,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date,
 sum(counted) AS sales_count,sum(gross_minor) AS gross_minor,sum(refund_minor) AS refund_minor,
 sum(commission_minor) AS commission_minor,sum(net_minor) AS net_minor FROM sources GROUP BY currency,mode,date ORDER BY date`,[merchantId,interval]);
 const currencies=[...new Set<string>([requireCanonicalCurrency(merchant.country),...rows.map(r=>r.currency)])].sort();
 // Explicitly reject unknown historical currencies rather than silently assuming two decimals.
 currencies.forEach(minorDigits);
 const currency=requestedCurrency&&currencies.includes(requestedCurrency)?requestedCurrency:requireCanonicalCurrency(merchant.country);
 const scale=10**minorDigits(currency);
 const empty=()=>({salesCount:0,gross:0,refunds:0,commission:0,net:0,averageSale:0});
 const summary=empty(),byMode:Record<string,ReturnType<typeof empty>>={CASH:empty(),POINTS_K:empty(),ONLINE:empty()};
 const days=new Map<string,any>();
 for(const row of rows.filter(row=>row.currency===currency)) {
   const values={salesCount:safe(row.sales_count),gross:safe(row.gross_minor),refunds:safe(row.refund_minor),commission:safe(row.commission_minor),net:safe(row.net_minor)};
   const mode=byMode[row.mode];if(!mode)throw new CashError('BUSINESS_MODE_INVALID',500);
   const daily=days.get(row.date)||{date:row.date,sales_count:0,gross:0,refunds:0,commission:0,net:0};
   for(const [key,value] of Object.entries(values)){
     (summary as any)[key]=safe((summary as any)[key]+value);(mode as any)[key]=safe((mode as any)[key]+value);
     const dailyKey=key==='salesCount'?'sales_count':key;daily[dailyKey]=safe(daily[dailyKey]+value);
   }
   days.set(row.date,daily);
 }
 const toMajor=(s:ReturnType<typeof empty>)=>({...s,gross:s.gross/scale,refunds:s.refunds/scale,commission:s.commission/scale,net:s.net/scale,
   averageSale:s.salesCount?(s.gross-s.refunds)/scale/s.salesCount:0});
 const {rows:recent}=await pool.query(BUSINESS_SALES_CTE+` SELECT id,reference,created_at,currency,mode,status,gross_minor,refund_minor,net_minor FROM sources WHERE currency=$3 ORDER BY created_at DESC,id DESC LIMIT 25`,[merchantId,interval,currency]);
 const {rows:receiptRows}=await pool.query(`SELECT receipt.status,count(*)::int AS total
 FROM konektag.merchant_cash_sales s JOIN LATERAL(SELECT status FROM konektag.merchant_cash_receipts
 WHERE sale_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) receipt ON true
 WHERE s.merchant_profile_id=$1 AND s.created_at>now()-$2::interval AND s.currency=$3 GROUP BY receipt.status`,[merchantId,interval,currency]);
 const receiptCounts=Object.fromEntries(receiptRows.map(r=>[r.status,safe(r.total)]));
 return {period,currency,currencies,receiptCounts,timezone:'UTC',summary:toMajor(summary),byMode:Object.fromEntries(Object.entries(byMode).map(([k,v])=>[k,toMajor(v)])),
   daily:[...days.values()].map(d=>({...d,gross:d.gross/scale,refunds:d.refunds/scale,commission:d.commission/scale,net:d.net/scale})),
   recent:recent.map(s=>({...s,gross:safe(s.gross_minor)/scale,refunds:safe(s.refund_minor)/scale,net:safe(s.net_minor)/scale})),
   notice:'Espèces reçues directement par le commerçant, exclues des reversements Konektag. Net des ventes indicatif après remboursements et commissions enregistrées ; les règlements font foi.'};
}
