import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({query:vi.fn(),balance:vi.fn(),owner:vi.fn(),control:vi.fn(),rate:vi.fn(),evidence:vi.fn()}));
vi.mock('../../src/infrastructure/database/pool.ts',()=>({default:{query:mocks.query}}));
vi.mock('../../src/application/services/k-points-service.ts',()=>({kPointsBalance:mocks.balance}));
vi.mock('../../src/application/services/pay/points-wallet-service.ts',()=>({resolvePointsOwner:mocks.owner}));
vi.mock('../../src/application/services/wallet-integrity-service.ts',()=>({financialAccountStatus:mocks.control}));
vi.mock('../../src/application/services/exchange-rate-service.ts',()=>({exchangeRateService:{
 isSupported:(currency:string)=>['EUR','XAF'].includes(currency),convert:mocks.rate,getRate:mocks.rate,getRateEvidence:mocks.evidence,
}}));

import {GET as balance} from '../../src/api/routes/account/balance.ts';
import {GET as history} from '../../src/api/routes/account/history/index.ts';

const context=(path:string)=>({request:new Request(`https://api.test${path}`),locals:{user:{id:'user-1'}}} as any);

describe('account wallet read contracts',()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.owner.mockResolvedValue('party-1');mocks.evidence.mockResolvedValue(null);});

 it('keeps pending net separate from confirmed and available balances',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{country:'FR',preferred_currency:null}]})
   .mockResolvedValueOnce({rows:[{net:'7'}]});
  mocks.balance.mockResolvedValue({balance:100,reserved:20,available:80});
  mocks.rate.mockResolvedValue({value:1,rate:1});mocks.control.mockResolvedValue({status:'ACTIVE'});
  const response=await balance(context('/api/account/balance'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({points_balance:100,points_reserved:20,points_available:80,points_pending_net:7,source:'ledger',valuation:{kind:'INDICATIVE'}});
  expect(mocks.query.mock.calls[1][1]).toEqual(['party-1','user-1']);
 });

 it('includes an unposted PSP order in history without treating it as confirmed K',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{country:'CG',preferred_currency:'XAF'}]})
   .mockResolvedValueOnce({rows:[{created_at:'2026-11-12T00:00:00Z',operation_type:'acquisition',direction:'credit',quantity_k:'4',
    source_type:'payment_order',source_id:'order-1',operation_id:'order-1',counterparty:null,status:'PROCESSING',
    business_reference:'PR-1',original_currency:'XAF',original_amount_minor:'8567',original_provider:'pawapay',total:1}]});
  mocks.rate.mockResolvedValue(650);mocks.evidence.mockResolvedValue({source:'test',valuedAt:'2026-11-12T00:00:00Z'});
  const response=await history(context('/api/account/history?currency=XAF'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({items:[{quantityK:4,status:'PROCESSING',sourceType:'payment_order',
   original:{amountMinor:8567,currency:'XAF',provider:'pawapay'}}]});
  expect(mocks.query.mock.calls[1][1]).toEqual(['party-1','user-1',50,0]);
 });

 it('returns signed, paginated history with canonical statuses',async()=>{
  mocks.query.mockResolvedValueOnce({rows:[{country:'FR',preferred_currency:'EUR'}]})
   .mockResolvedValueOnce({rows:[{created_at:'2026-11-12T00:00:00Z',operation_type:'k_send',direction:'debit',quantity_k:'4',source_type:'k_send',source_id:'send-1',operation_id:'op-1',counterparty:'Ada',status:'COMPLETED',business_reference:'ref-1',total:1}]});
  mocks.rate.mockResolvedValue(1);
  const response=await history(context('/api/account/history?limit=10&offset=0'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({items:[{quantityK:-4,status:'COMPLETED',reference:'ref-1',counterparty:'Ada',
   original:{amountMinor:null,currency:null,provider:null}}],pagination:{limit:10,offset:0,total:1}});
 });

 it('never hides a history database failure behind an empty 200',async()=>{
  mocks.query.mockRejectedValueOnce(new Error('database unavailable'));
  const response=await history(context('/api/account/history'));
  expect(response.status).toBe(503);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({error:'WALLET_HISTORY_UNAVAILABLE'});
 });
});
