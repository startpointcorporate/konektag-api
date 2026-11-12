/** Offline import of existing, approved commercial terms into the API reference.
 * Input: JSON array exported from the authorised source, with original approval evidence.
 * No ERP call, approval creation, environment fallback or financial operation. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
const term=z.object({
 network_site:z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),beneficiary_site:z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/),
 beneficiary_name:z.string().trim().min(1).max(140),country:z.string().regex(/^[A-Z]{2}$/),
 enabled:z.boolean(),approved:z.boolean(),approved_by:z.string().trim().min(1).nullable(),
 approved_on:z.string().datetime({offset:true}).nullable(),
 terms_hash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),fee_mode:z.enum(['Percentage','Exempt']),
 fee_rate_bps:z.number().int().min(0).max(10000),payout_ready:z.boolean(),
}).strict().refine(t=>!t.approved||(t.approved_by!==null&&t.approved_on!==null&&t.terms_hash!==null),'Missing approval evidence').refine(t=>t.fee_mode==='Exempt'?t.fee_rate_bps===0:t.fee_rate_bps>0,'Invalid fee rule');
const path=process.argv[2];
if(!path||!process.env.DATABASE_URL)throw new Error('Usage: DATABASE_URL=… node scripts/import-link-pay-terms.mjs <approved-export.json>');
const terms=z.array(term).min(1).parse(JSON.parse(await fs.readFile(path,'utf8')));
const keys=terms.map(t=>t.network_site+':'+t.beneficiary_site);
if(new Set(keys).size!==keys.length)throw new Error('Duplicate collection reference');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const client=await pool.connect();
try{
 await client.query('BEGIN');
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended('link-pay-terms-import',0))");
 for(const t of terms){
  const {rows:[before]}=await client.query('SELECT * FROM konektag.link_pay_beneficiary_terms WHERE network_site=$1 AND beneficiary_site=$2 FOR UPDATE',[t.network_site,t.beneficiary_site]);
  if(before&&t.approved&&t.approved_on&&before.approved_on&&new Date(t.approved_on)<new Date(before.approved_on))throw new Error('Stale approval export');
  const {rowCount}=await client.query(`INSERT INTO konektag.link_pay_beneficiary_terms
   (network_site,beneficiary_site,beneficiary_name,country,enabled,approved,approved_by,approved_on,terms_hash,fee_mode,fee_rate_bps,payout_ready)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
   ON CONFLICT(network_site,beneficiary_site) DO UPDATE SET
    beneficiary_name=EXCLUDED.beneficiary_name,country=EXCLUDED.country,enabled=EXCLUDED.enabled,approved=EXCLUDED.approved,
    approved_by=EXCLUDED.approved_by,approved_on=EXCLUDED.approved_on,terms_hash=EXCLUDED.terms_hash,
    fee_mode=EXCLUDED.fee_mode,fee_rate_bps=EXCLUDED.fee_rate_bps,payout_ready=EXCLUDED.payout_ready,updated_at=now()
   WHERE (to_jsonb(link_pay_beneficiary_terms)-'updated_at') IS DISTINCT FROM (to_jsonb(EXCLUDED)-'updated_at')`,
   [t.network_site,t.beneficiary_site,t.beneficiary_name,t.country,t.enabled,t.approved,t.approved_by,t.approved_on,t.terms_hash,t.fee_mode,t.fee_rate_bps,t.payout_ready]);
  if(rowCount)await client.query(`INSERT INTO konektag.audit_logs(correlation_id,event_type,payload)
   VALUES($1,'LinkPayTermsImported',$2::jsonb)`,[crypto.randomUUID(),JSON.stringify({before:before??null,after:t})]);
 }
 await client.query('COMMIT');
 console.log(JSON.stringify({imported:terms.length,references:keys}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
