import type { PoolClient } from 'pg';
import { evaluateWallet, type WalletSnapshot } from './wallet-integrity-rules.ts';
type Database=Pick<PoolClient,'query'>;

export async function financialAccountStatus(db:Database,partyId:string) {
 const {rows:[row]}=await db.query(`SELECT status,COALESCE(source_alert_id::text,party_id::text) AS reference,version
  FROM konektag.financial_account_controls WHERE party_id=$1`,[partyId]);
 return row??{status:'ACTIVE',reference:null,version:0};
}
// Caller must keep this lock until its financial transaction commits.
export async function requireFinancialAccountActive(db:Database,partyId:string) {
 await db.query('SELECT konektag.require_financial_account_active($1)',[partyId]);
}
export async function walletSnapshot(db:Database,partyId:string):Promise<WalletSnapshot> {
 const {rows:[row]}=await db.query(`WITH w AS (SELECT * FROM konektag.k_wallet_entries WHERE party_id=$1),
 l AS (SELECT e.id,COALESCE(e.k_operation_id,e.transaction_id) AS transaction_id,e.entry_side,e.amount::text,COALESCE(k.status,t.status) AS status FROM konektag.ledger_entries e
 LEFT JOIN konektag.financial_transactions t ON t.id=e.transaction_id
 LEFT JOIN konektag.k_operations k ON k.id=e.k_operation_id WHERE e.party_id=$1 AND e.account_code='1000'
 AND e.currency='K' AND e.gl_scope='GLOBAL_USER_GL' AND (t.status IN ('completed','reversed') OR k.status='completed')),
 x AS (SELECT e.* FROM konektag.k_wallet_entries e WHERE e.source_type='k_send'
 AND e.operation_id IN (SELECT operation_id FROM w WHERE source_type='k_send'))
 SELECT konektag.k_wallet_balance($1)::text observed,
 (SELECT reserved::text FROM konektag.points_balance($1)) reserved,
 COALESCE((SELECT jsonb_agg(to_jsonb(w)||jsonb_build_object('quantity_k',quantity_k::text)) FROM w),'[]') entries,
 COALESCE((SELECT jsonb_agg(l) FROM l),'[]') ledger,
 COALESCE((SELECT jsonb_agg(to_jsonb(x)||jsonb_build_object('quantity_k',quantity_k::text)) FROM x),'[]') transfers,
 COALESCE((SELECT jsonb_agg(DISTINCT x.operation_id) FROM x WHERE NOT EXISTS (
 SELECT 1 FROM konektag.k_send_intents i JOIN konektag.users u ON u.id=i.sender_user_id
 JOIN konektag.parties p ON p.keycloak_id=u.keycloak_id
 JOIN konektag.users ru ON ru.id=i.recipient_user_id JOIN konektag.parties rp ON rp.keycloak_id=ru.keycloak_id
 WHERE x.source_id='k_send:'||i.id::text AND i.status='Funded' AND i.quantity_k=x.quantity_k AND i.operation_id=x.operation_id
 AND ((x.direction='debit' AND p.id=x.party_id AND rp.id=x.counterparty_party_id)
 OR (x.direction='credit' AND rp.id=x.party_id AND p.id=x.counterparty_party_id)))),'[]') "unprovenTransfers",
 COALESCE((SELECT jsonb_agg(e.id ORDER BY e.id) FROM konektag.ledger_entries e WHERE e.party_id=$1
 AND e.currency='K' AND e.account_code='1000' AND e.document_type='points_acquisition'
 AND e.transaction_id IN (SELECT transaction_id FROM l) AND NOT EXISTS (
 SELECT 1 FROM konektag.points_acquisitions a JOIN konektag.points_payment_confirmations c ON c.order_id=a.order_id
 JOIN konektag.points_lots lot ON lot.id=a.lot_id JOIN konektag.api_payment_orders o ON o.id=a.order_id
 WHERE a.transaction_id=e.transaction_id AND a.party_id=e.party_id AND a.quantity=e.amount AND a.status='completed'
 AND lot.quantity=a.quantity AND c.currency=lot.currency AND c.applied_at IS NOT NULL
 AND o.state='paid' AND o.acquisition_status='completed')),'[]') "unprovenAcquisitions",
 COALESCE((SELECT jsonb_agg(to_jsonb(t)::text ORDER BY t.transaction_id) FROM (
 SELECT COALESCE(e.k_operation_id,e.transaction_id) AS transaction_id,jsonb_agg(jsonb_build_object('id',e.id,'side',e.entry_side,'amount',e.amount::text) ORDER BY e.id) legs FROM konektag.ledger_entries e WHERE COALESCE(e.k_operation_id,e.transaction_id) IN (SELECT transaction_id FROM l)
 AND e.currency='K' AND e.gl_scope='GLOBAL_USER_GL' GROUP BY COALESCE(e.k_operation_id,e.transaction_id)
 HAVING sum(CASE WHEN entry_side='credit' THEN amount ELSE -amount END)<>0) t),'[]') "brokenTransactions"`,[partyId]);
 return {partyId,...row};
}
export function enforcementRules():Set<string> {
 return process.env.WALLET_INTEGRITY_MODE==='ENFORCE'
  ? new Set((process.env.WALLET_INTEGRITY_ENFORCE_RULES??'').split(',').map(s=>s.trim()).filter(Boolean)):new Set();
}
export async function scanWallet(db:Database,partyId:string,rules=enforcementRules()) {
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`points-wallet:${partyId}`]);
 const snapshot=await walletSnapshot(db,partyId);
 const threshold=process.env.WALLET_INTEGRITY_WARNING_THRESHOLD;
 const findings=evaluateWallet(snapshot,threshold&&/^\d+$/.test(threshold)?BigInt(threshold):undefined);
 const ids:string[]=[];
 for(const finding of findings) {
  const {rows:[alert]}=await db.query(`INSERT INTO konektag.wallet_integrity_alerts
   (party_id,rule_code,severity,observed_balance,expected_balance,difference,fingerprint,details)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(party_id,rule_code,fingerprint)
   DO UPDATE SET last_seen_at=now(),status=CASE WHEN konektag.wallet_integrity_alerts.status='RESOLVED' THEN 'OPEN' ELSE konektag.wallet_integrity_alerts.status END RETURNING *, (xmax=0) AS inserted`,[partyId,finding.ruleCode,finding.severity,
   finding.observed,finding.expected,finding.difference,finding.fingerprint,JSON.stringify(finding.details)]);
  ids.push(alert.id);
  if(alert.inserted) await recordControlEvent(db,partyId,null,'ALERT_DETECTED',finding.ruleCode,alert.id,{severity:finding.severity,fingerprint:finding.fingerprint});
  if(finding.severity==='CRITICAL' && rules.has(finding.ruleCode) && !['FALSE_POSITIVE','RESOLVED'].includes(alert.status)) {
   const {rows}=await db.query(`INSERT INTO konektag.financial_account_controls(party_id,status,source_alert_id,blocked_at)
    VALUES($1,'BLOCKED',$2,now()) ON CONFLICT(party_id) DO UPDATE SET status='BLOCKED',source_alert_id=$2,
    blocked_at=now(),blocked_by=NULL,version=konektag.financial_account_controls.version+1
    WHERE konektag.financial_account_controls.status='ACTIVE'
    AND (konektag.financial_account_controls.suppression_until IS NULL OR konektag.financial_account_controls.suppression_until<=now()) RETURNING party_id`,[partyId,alert.id]);
   if(rows.length) await recordControlEvent(db,partyId,null,'AUTO_BLOCK','Validated critical rule',alert.id);
  }
 }
 // Resolve disappeared occurrences, never release a hold automatically.
 await db.query(`UPDATE konektag.wallet_integrity_alerts SET status='RESOLVED',resolved_at=now(),resolution_reason='No longer detected'
  WHERE party_id=$1 AND status IN ('OPEN','ACKNOWLEDGED') AND NOT(id=ANY($2::uuid[]))`,[partyId,ids]);
 return {snapshot,findings,alertIds:ids};
}
export async function recordControlEvent(db:Database,partyId:string,actorId:string|null,action:string,reason:string,alertId:string|null=null,details:unknown={}) {
 await db.query(`INSERT INTO konektag.financial_account_control_events(party_id,actor_id,action,reason,alert_id,details)
 VALUES($1,$2,$3,$4,$5,$6)`,[partyId,actorId,action,reason,alertId,JSON.stringify(details)]);
}
export type ControlAction='ACKNOWLEDGE'|'FALSE_POSITIVE'|'RELEASE'|'MAINTAIN'|'RECHECK';
export async function controlAction(db:Database,input:{partyId:string;actorId:string;action:ControlAction;reason:string;alertId?:string;version:number}) {
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`points-wallet:${input.partyId}`]);
 const current=await financialAccountStatus(db,input.partyId);
 if(current.version!==input.version) throw new Error('FINANCIAL_CONTROL_VERSION_CONFLICT');
 const scan=await scanWallet(db,input.partyId,new Set());
 if(input.action==='ACKNOWLEDGE' || input.action==='FALSE_POSITIVE') {
  if(!input.alertId || !scan.alertIds.includes(input.alertId)) throw new Error('CURRENT_ALERT_REQUIRED');
  await db.query(`UPDATE konektag.wallet_integrity_alerts SET status=$3,acknowledged_at=now(),acknowledged_by=$4,
   resolution_reason=$5 WHERE id=$1 AND party_id=$2`,[input.alertId,input.partyId,input.action==='FALSE_POSITIVE'?'FALSE_POSITIVE':'ACKNOWLEDGED',input.actorId,input.reason]);
 }
 if(input.action==='RELEASE' || input.action==='FALSE_POSITIVE') {
  const {rows}=await db.query(`SELECT id FROM konektag.wallet_integrity_alerts WHERE id=ANY($1::uuid[]) AND severity='CRITICAL' AND status<>'FALSE_POSITIVE'`,[scan.alertIds]);
  if(rows.length && input.action==='RELEASE') throw new Error('CRITICAL_ANOMALY_REMAINS');
  if(!rows.length) await db.query(`INSERT INTO konektag.financial_account_controls(party_id,status,released_at,released_by,release_reason)
   VALUES($1,'ACTIVE',now(),$2,$3) ON CONFLICT(party_id) DO UPDATE SET status='ACTIVE',released_at=now(),released_by=$2,
   release_reason=$3,suppression_until=NULL,version=konektag.financial_account_controls.version+1`,[input.partyId,input.actorId,input.reason]);
 }
 if(input.action==='MAINTAIN') await db.query(`INSERT INTO konektag.financial_account_controls(party_id,status,blocked_at,blocked_by)
  VALUES($1,'REVIEW',now(),$2) ON CONFLICT(party_id) DO UPDATE SET status='REVIEW',blocked_at=now(),blocked_by=$2,
  version=konektag.financial_account_controls.version+1`,[input.partyId,input.actorId]);
 if(['ACKNOWLEDGE','RECHECK'].includes(input.action)) await db.query(`INSERT INTO konektag.financial_account_controls(party_id)
 VALUES($1) ON CONFLICT(party_id) DO UPDATE SET version=konektag.financial_account_controls.version+1`,[input.partyId]);
 await recordControlEvent(db,input.partyId,input.actorId,input.action,input.reason,input.alertId??null,{fingerprints:scan.findings.map(f=>f.fingerprint)});
 return financialAccountStatus(db,input.partyId);
}
