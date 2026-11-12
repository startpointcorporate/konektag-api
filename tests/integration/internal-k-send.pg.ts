import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isolatedKUser } from '../helpers/isolated-k-wallet.ts';
vi.mock('../../src/application/services/resend-service.ts',()=>({emailService:{send:vi.fn()}}));
vi.mock('../../src/infrastructure/adapters/encryption-service.ts',()=>({encryptionService:{decrypt:()=>'{"email":null}'}}));
const url=new URL(process.env.DATABASE_URL!);
if(url.pathname!=='/konektag_test'||!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Local throwaway database required');
const {default:pool}=await import('../../src/infrastructure/database/pool.ts');
const {kSendService}=await import('../../src/application/services/k-send-application-service.ts');
const {kPointsBalance,transferKPoints}=await import('../../src/application/services/k-points-service.ts');
afterAll(()=>pool.end());
const create=async(sender:any,recipient:any,quantityK=10)=>(await kSendService.create({senderId:sender.id,recipientUserId:recipient.id,quantityK})).send;

describe('Internal K sends use the canonical API ledger without ERP',()=>{
 it('transfers with all GIFT profiles still DRAFT; one intent, two ledger legs, no financial transaction',async()=>{
  const sender=await isolatedKUser(pool),recipient=await isolatedKUser(pool,0);
  const send=await create(sender,recipient);
  const result=await kSendService.execute(send.id,'isolated-otp:'+randomUUID());
  expect(result.status).toBe('Funded');
  expect(await kPointsBalance(sender.party)).toMatchObject({balance:90,available:90});
  expect(await kPointsBalance(recipient.party)).toMatchObject({balance:10});
  const {rows:legs}=await pool.query('SELECT * FROM konektag.ledger_entries WHERE k_operation_id=$1',[result.operationId]);
  expect(legs).toHaveLength(2);expect(legs.map(l=>l.entry_side).sort()).toEqual(['credit','debit']);
  expect(legs.every(l=>l.transaction_id===null&&l.regulatory_profile_id===null&&l.corridor_id===null&&Number(l.amount)===10)).toBe(true);
  expect((await pool.query('SELECT id FROM konektag.financial_transactions WHERE idempotency_key=$1',['k_send:'+send.id])).rows).toHaveLength(0);
  expect((await pool.query("SELECT status FROM konektag.regulatory_profiles WHERE profile_code LIKE 'GIFT-%'")).rows.every(r=>r.status==='DRAFT')).toBe(true);
  expect((await pool.query('SELECT * FROM konektag.k_wallet_entries WHERE operation_id=$1',[result.operationId])).rows).toHaveLength(2);
  const {GET:history}=await import('../../src/api/routes/account/history/index.ts');
  for(const [user,quantity,counterparty] of [[sender,-10,recipient.id],[recipient,10,sender.id]] as const){
   const response=await history({locals:{user},request:new Request('http://x/api/account/history?currency=EUR')} as any);
   expect(response.status).toBe(200);
   const body=await response.json(),items=body.items.filter((item:any)=>item.operationId===result.operationId);
   expect(items).toHaveLength(1);expect(items[0]).toMatchObject({type:'k_send',quantityK:quantity,counterparty,status:'COMPLETED'});
  }

 });
 it('concurrent retries return one operation and never double debit or notify',async()=>{
  const a=await isolatedKUser(pool),b=await isolatedKUser(pool,0),send=await create(a,b);
  const results=await Promise.all([kSendService.execute(send.id,'otp'),kSendService.execute(send.id,'otp')]);
  expect(results[0].operationId).toBe(results[1].operationId);
  expect((await pool.query('SELECT * FROM konektag.notifications WHERE event_key=$1',['k-send-received:'+send.id])).rows).toHaveLength(1);
  expect((await kPointsBalance(a.party)).balance).toBe(90);
 });
 it('respects active reservations and atomically rejects insufficient funds',async()=>{
  const a=await isolatedKUser(pool,20),b=await isolatedKUser(pool,0);
  await pool.query(`INSERT INTO konektag.api_payment_wallet_reservations(payer_party_id,amount,currency,lifecycle,expires_at,operation_key)
   VALUES($1,15,'K','active',now()+interval '1 hour',$2)`,[a.party,randomUUID()]);
  const send=await create(a,b,10);
  await expect(kSendService.execute(send.id,'otp')).rejects.toThrow('K_SEND_INSUFFICIENT');
  expect((await kSendService.get(send.id)).status).toBe('Quoted');
  expect(await kPointsBalance(a.party)).toMatchObject({balance:20,available:5});
  expect((await kPointsBalance(b.party)).balance).toBe(0);
 });
 it('serializes competing intents against the same available balance',async()=>{
  const a=await isolatedKUser(pool,15),b=await isolatedKUser(pool,0),c=await isolatedKUser(pool,0);
  const sends=await Promise.all([create(a,b),create(a,c)]);
  const results=await Promise.allSettled(sends.map(s=>kSendService.execute(s.id,'otp')));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await kPointsBalance(a.party)).balance).toBe(5);
 });
 it('rejects unverified sender and recipient, and never revives cancellation',async()=>{
  const a=await isolatedKUser(pool,100,'COMPLETED'),b=await isolatedKUser(pool,0);
  const send=await create(a,b);
  await expect(kSendService.execute(send.id,'otp')).rejects.toThrow('USER_KYC_REQUIRED');
  await pool.query("UPDATE konektag.users SET state='KYC_VALIDATED' WHERE id=$1",[a.id]);
  await pool.query("UPDATE konektag.users SET state='COMPLETED' WHERE id=$1",[b.id]);
  await expect(kSendService.execute(send.id,'otp')).rejects.toThrow('USER_KYC_REQUIRED');
  await kSendService.cancel(send.id);
  await expect(kSendService.execute(send.id,'otp')).rejects.toThrow('K_SEND_STATE_CONFLICT');
 });
 it('database rejects an unbacked transfer and forbids reopening a completed operation',async()=>{
  const a=await isolatedKUser(pool),b=await isolatedKUser(pool,0),send=await create(a,b);
  const result=await kSendService.execute(send.id,'otp');
  await expect(pool.query("UPDATE konektag.k_operations SET status='pending',completed_at=NULL WHERE id=$1",[result.operationId])).rejects.toThrow('K_OPERATION_IMMUTABLE');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   await transferKPoints(client,{senderPartyId:a.party,recipientPartyId:b.party,quantityK:1,operationKey:'unbacked:'+randomUUID()});
   await expect(client.query('COMMIT')).rejects.toThrow('K_SEND_INTENT_PROOF_REQUIRED');
  }finally{await client.query('ROLLBACK');client.release();}
  expect((await kPointsBalance(a.party)).balance).toBe(90);
 });
});
