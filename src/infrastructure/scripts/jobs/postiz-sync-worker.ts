import pool from '../../database/pool.ts';
import {reconcileCampaign,postizErrorCode} from '../../../application/services/merchant-social-service.ts';
async function main(){
 const {rows}=await pool.query(`SELECT id FROM konektag.merchant_social_campaigns
 WHERE state IN ('SENDING','SCHEDULED','UNCERTAIN','CANCELLING','CANCEL_UNCERTAIN')
 AND updated_at<now()-interval '2 minutes' AND (provider_checked_at IS NULL OR provider_checked_at<now()-interval '5 minutes')
 ORDER BY provider_checked_at NULLS FIRST,created_at LIMIT 5`);
 let failures=0;
 for(const c of rows){try{await reconcileCampaign(c.id);}catch(e){failures++;await pool.query(`UPDATE konektag.merchant_social_campaigns SET provider_checked_at=now(),last_error=$2 WHERE id=$1
 AND state IN ('SENDING','SCHEDULED','UNCERTAIN','CANCELLING','CANCEL_UNCERTAIN')`,[c.id,postizErrorCode(e)]);console.error('[postiz-sync]',c.id,postizErrorCode(e));}}
 console.log(JSON.stringify({checked:rows.length,failures}));if(failures)process.exitCode=1;
}
main().catch(()=>{console.error('[postiz-sync] Worker failed');process.exitCode=1;}).finally(()=>pool.end());
