import { createHash } from 'node:crypto';

export interface WalletEntry {
 id:string; party_id:string; operation_id:string; direction:string; quantity_k:string;
 source_type:string; source_id:string; counterparty_party_id:string|null;
}
export interface LedgerProof {
 id:string; transaction_id:string; entry_side:string; amount:string; status:string;
}
export interface WalletSnapshot {
 partyId:string; observed:string; reserved:string; entries:WalletEntry[]; ledger:LedgerProof[];
 transfers:WalletEntry[]; unprovenAcquisitions?:unknown[]; unprovenTransfers:string[]; brokenTransactions:string[];
}
export interface IntegrityFinding {
 ruleCode:string; severity:'WARNING'|'CRITICAL'; observed:string; expected:string; difference:string;
 fingerprint:string; details:Record<string,unknown>;
}
const signed = (direction:string,quantity:string) => (direction==='credit'?1n:-1n)*BigInt(quantity);
const integer = (amount:string) => /^\d+(\.0+)?$/.test(amount);
const canonical = (value:unknown):string => {
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
};
export function evaluateWallet(snapshot:WalletSnapshot, warningThreshold?:bigint):IntegrityFinding[] {
 const entries=[...snapshot.entries].sort((a,b)=>a.id.localeCompare(b.id));
 const ledger=[...snapshot.ledger].sort((a,b)=>a.id.localeCompare(b.id));
 const reconstructed=entries.reduce((s,e)=>s+signed(e.direction,e.quantity_k),0n);
 const expected=ledger.filter(e=>integer(e.amount)).reduce((s,e)=>s+signed(e.entry_side,e.amount.split('.')[0]),0n)
  +entries.filter(e=>e.source_type==='k_send').reduce((s,e)=>s+signed(e.direction,e.quantity_k),0n);
 const observed=BigInt(snapshot.observed), findings:IntegrityFinding[]=[];
 const add=(ruleCode:string,severity:'WARNING'|'CRITICAL',details:Record<string,unknown>)=> {
  const evidence={version:1,partyId:snapshot.partyId,ruleCode,observed:String(observed),expected:String(expected),details};
  findings.push({ruleCode,severity,observed:String(observed),expected:String(expected),difference:String(observed-expected),
   fingerprint:createHash('sha256').update(canonical(evidence)).digest('hex'),details});
 };
 if(observed!==reconstructed || observed!==expected) add('BALANCE_LEDGER_MISMATCH','CRITICAL',{reconstructed:String(reconstructed),entries,ledger});
 if(observed<0n || observed-BigInt(snapshot.reserved)<0n) add('NEGATIVE_IMPOSSIBLE_BALANCE','CRITICAL',{reserved:snapshot.reserved,entries});
 const sources=new Map<string,string[]>();
 for(const e of entries) {const key=canonical([e.source_type,e.source_id,e.direction]);sources.set(key,[...(sources.get(key)??[]),e.id]);}
 const duplicates=[...sources.entries()].filter(([,ids])=>ids.length>1);
 if(duplicates.length) add('DUPLICATE_FINANCIAL_SOURCE','CRITICAL',{duplicates});
 const unexplained=entries.filter(e=>e.source_type!=='k_send' && (!['legacy_ledger','k_operation_ledger'].includes(e.source_type) || !ledger.some(l=>
  l.id===e.source_id && l.transaction_id===e.operation_id && l.entry_side===e.direction && integer(l.amount) && BigInt(l.amount.split('.')[0])===BigInt(e.quantity_k))));
 if(unexplained.length || snapshot.unprovenAcquisitions?.length) add('UNEXPLAINED_CREDIT','CRITICAL',{entries:unexplained,acquisitions:snapshot.unprovenAcquisitions??[]});
 const missing=ledger.filter(l=>!entries.some(e=>['legacy_ledger','k_operation_ledger'].includes(e.source_type)&&e.source_id===l.id));
 const broken:string[]=[...snapshot.unprovenTransfers,...snapshot.brokenTransactions];
 for(const op of new Set(entries.filter(e=>e.source_type==='k_send').map(e=>e.operation_id))) {
  const pair=snapshot.transfers.filter(e=>e.operation_id===op);
  const debit=pair.find(e=>e.direction==='debit'),credit=pair.find(e=>e.direction==='credit');
  if(pair.length!==2 || !debit || !credit || debit.quantity_k!==credit.quantity_k || debit.party_id===credit.party_id
   || debit.counterparty_party_id!==credit.party_id || credit.counterparty_party_id!==debit.party_id || debit.source_id!==credit.source_id) broken.push(op);
 }
 const nonIntegerLedger=ledger.filter(l=>!integer(l.amount));
 // Historical traceability gaps do not prove a wrong balance when the wallet
 // still reconciles. Keep them visible for investigation, but never classify
 // them as an enforcement-eligible accounting failure.
 if((missing.length || broken.length) && observed===reconstructed && observed===expected && !nonIntegerLedger.length) {
  add('HISTORICAL_TRACEABILITY_GAP','WARNING',{
   missing,operations:[...new Set(broken)].sort(),transfers:[...snapshot.transfers].sort((a,b)=>a.id.localeCompare(b.id)),ledger});
 } else if(missing.length || broken.length || nonIntegerLedger.length) {
  add('BROKEN_ACCOUNTING_INVARIANT','CRITICAL',{
   missing,operations:[...new Set(broken)].sort(),transfers:[...snapshot.transfers].sort((a,b)=>a.id.localeCompare(b.id)),ledger});
 }
 if(warningThreshold && observed>warningThreshold) add('HIGH_BALANCE_REVIEW','WARNING',{threshold:String(warningThreshold),entries});
 return findings;
}
