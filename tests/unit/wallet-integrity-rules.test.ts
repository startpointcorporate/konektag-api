import { describe,it,expect } from 'vitest';
import { evaluateWallet,type WalletSnapshot,type WalletEntry } from '../../src/application/services/wallet-integrity-rules.ts';
const entry=(id:string,quantity='100'):WalletEntry=>({id,party_id:'p',operation_id:id,direction:'credit',quantity_k:quantity,source_type:'legacy_ledger',source_id:id,counterparty_party_id:null});
const snapshot=(entries:WalletEntry[]=[]):WalletSnapshot=>({partyId:'p',observed:'0',reserved:'0',entries,ledger:[],transfers:[],unprovenTransfers:[],brokenTransactions:[]});
describe('Wallet Integrity deterministic rules',()=>{
 it('WI-01 empty wallet is valid',()=>expect(evaluateWallet(snapshot())).toEqual([]));
 it('does not classify high balances as CRITICAL',()=>{
  const s=snapshot([entry('e','24000')]);s.observed='24000';s.ledger=[{id:'e',transaction_id:'e',entry_side:'credit',amount:'24000.00',status:'completed'}];
  expect(evaluateWallet(s)).toEqual([]);expect(evaluateWallet(s,1000n).map(f=>f.severity)).toEqual(['WARNING']);
 });
 it('WI-10 detects mismatch and unsupported source',()=>{
  const findings=evaluateWallet({...snapshot([entry('e')]),observed:'100'});
  expect(findings.map(f=>f.ruleCode)).toEqual(['BALANCE_LEDGER_MISMATCH','UNEXPLAINED_CREDIT']);
 });
 it('classifies reconciled historical transfer traceability gaps as WARNING',()=>{
  const debit:WalletEntry={id:'d',party_id:'p',operation_id:'old-op',direction:'debit',quantity_k:'10',source_type:'k_send',source_id:'k_send:old',counterparty_party_id:'q'};
  const credit:WalletEntry={id:'c',party_id:'q',operation_id:'old-op',direction:'credit',quantity_k:'10',source_type:'k_send',source_id:'k_send:old',counterparty_party_id:'p'};
  const s={...snapshot([debit]),observed:'-10',transfers:[debit,credit],unprovenTransfers:['old-op']};
  const findings=evaluateWallet(s);
  expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ruleCode:'HISTORICAL_TRACEABILITY_GAP',severity:'WARNING',difference:'0'})]));
  expect(findings.some(f=>f.ruleCode==='BROKEN_ACCOUNTING_INVARIANT')).toBe(false);
 });
 it('WI-15/16 fingerprint is stable and changes with responsible data',()=>{
  const s={...snapshot([entry('e')]),observed:'100'};
  expect(evaluateWallet(s)[0].fingerprint).toBe(evaluateWallet(JSON.parse(JSON.stringify(s)))[0].fingerprint);
  expect(evaluateWallet({...s,observed:'75000'})[0].fingerprint).not.toBe(evaluateWallet(s)[0].fingerprint);
 });
 it('detects duplicates even when different operation IDs exist',()=>{
  const s=snapshot([entry('a'),{...entry('b'),source_id:'a'}]);
  expect(evaluateWallet(s).some(f=>f.ruleCode==='DUPLICATE_FINANCIAL_SOURCE')).toBe(true);
 });
 it('separates reconciled transfer traceability warnings from impossible reservations',()=>{
  const e={...entry('e'),source_type:'k_send'};const s={...snapshot([e]),transfers:[e],reserved:'101',observed:'100'};
  expect(evaluateWallet(s).map(({ruleCode,severity,difference})=>({ruleCode,severity,difference}))).toEqual([
   {ruleCode:'NEGATIVE_IMPOSSIBLE_BALANCE',severity:'CRITICAL',difference:'0'},
   {ruleCode:'HISTORICAL_TRACEABILITY_GAP',severity:'WARNING',difference:'0'},
  ]);
 });
 it('reports only a non-enforcement warning for a historical gap with three equal balances',()=>{
  const e={...entry('e'),source_type:'k_send'};
  const findings=evaluateWallet({...snapshot([e]),transfers:[e],observed:'100'});
  expect(findings.map(({ruleCode,severity,observed,expected,difference})=>({ruleCode,severity,observed,expected,difference}))).toEqual([
   {ruleCode:'HISTORICAL_TRACEABILITY_GAP',severity:'WARNING',observed:'100',expected:'100',difference:'0'},
  ]);
 });
 it('classifies a broken transfer with an actual balance mismatch as CRITICAL',()=>{
  const e={...entry('e'),source_type:'k_send'};
  const findings=evaluateWallet({...snapshot([e]),transfers:[e],observed:'99'});
  expect(findings.map(({ruleCode,severity,difference})=>({ruleCode,severity,difference}))).toEqual([
   {ruleCode:'BALANCE_LEDGER_MISMATCH',severity:'CRITICAL',difference:'-1'},
   {ruleCode:'BROKEN_ACCOUNTING_INVARIANT',severity:'CRITICAL',difference:'-1'},
  ]);
 });
 it('retains integer precision above Number.MAX_SAFE_INTEGER',()=>{
  const s={...snapshot([entry('e','9007199254740993')]),observed:'9007199254740993'};
  expect(evaluateWallet(s)[0].difference).toBe('9007199254740993');
 });
});
