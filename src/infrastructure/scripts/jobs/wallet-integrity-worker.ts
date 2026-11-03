import pool from '../../database/pool.ts';
import { scanWallet } from '../../../application/services/wallet-integrity-service.ts';
// Keyset pagination, bounded transactions, no balance corrections.
let cursor='00000000-0000-0000-0000-000000000000';
let inspected=0,failed=0;
try {
 for(;;) {
  const {rows}=await pool.query(`SELECT id FROM konektag.parties WHERE id>$1 AND (
   EXISTS(SELECT 1 FROM konektag.k_wallet_entries WHERE party_id=parties.id) OR
   EXISTS(SELECT 1 FROM konektag.ledger_entries WHERE party_id=parties.id AND currency='K') OR
   EXISTS(SELECT 1 FROM konektag.financial_account_controls WHERE party_id=parties.id) OR
   EXISTS(SELECT 1 FROM konektag.api_payment_wallet_reservations WHERE payer_party_id=parties.id AND currency='K'))
   ORDER BY id LIMIT 100`,[cursor]);
  if(!rows.length) break;
  for(const row of rows) {
   const db=await pool.connect();
   try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    const result=await scanWallet(db,row.id);
    await db.query('COMMIT');
    console.log(JSON.stringify({event:'wallet_integrity_scan',partyId:row.id,alerts:result.alertIds,
     rules:result.findings.map(f=>f.ruleCode),mode:process.env.WALLET_INTEGRITY_MODE??'OBSERVE'}));
    inspected++;
   } catch(error) {
    await db.query('ROLLBACK');failed++;
    console.error(JSON.stringify({event:'wallet_integrity_scan_failed',partyId:row.id,code:(error as {code?:string}).code??'UNKNOWN'}));
   } finally {db.release();}
  }
  cursor=rows.at(-1)!.id;
 }
} finally {await pool.end();}
console.log(JSON.stringify({event:'wallet_integrity_job_complete',inspected,failed}));
if(failed) process.exitCode=1;
