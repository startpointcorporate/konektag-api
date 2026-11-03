import {beforeEach,describe,expect,it,vi} from 'vitest';
const db=vi.hoisted(()=>({query:vi.fn(),connect:vi.fn(),release:vi.fn(),tx:vi.fn()}));
vi.mock('../../src/infrastructure/database/pool.ts',()=>({default:{query:db.query,connect:db.connect}}));
vi.mock('../../src/infrastructure/correlation-id.ts',()=>({getCorrelationId:()=> 'correlation'}));
import {contactService} from '../../src/application/services/contact-service.ts';
beforeEach(()=>{
 vi.resetAllMocks();db.query.mockResolvedValue({rows:[{id:'A',user_id:'owner',business_name:'A'}]});
 db.connect.mockResolvedValue({query:db.tx,release:db.release});
 db.tx.mockImplementation(async(sql:string)=>({rows:sql.includes('RETURNING *')?[{id:'message-A'}]:[]}));
});
const analytics=()=>db.tx.mock.calls.filter(([sql])=>sql.includes('INSERT INTO konektag.profile_analytics'));
describe('confirmed internal message analytics',()=>{
 it('records exactly once after persistence, with the message id, before commit',async()=>{
  await contactService.sendMessage('A','Visitor','visitor@example.test','Hello');
  expect(analytics()).toHaveLength(1);expect(analytics()[0][1]).toEqual(['A',JSON.stringify({messageId:'message-A'})]);
  const calls=db.tx.mock.calls.map(([sql])=>sql);expect(calls.findIndex(s=>s.includes('contact_messages'))).toBeLessThan(calls.findIndex(s=>s.includes('profile_analytics')));expect(calls.at(-1)).toBe('COMMIT');
 });
 it.each(['owner','manager'])('excludes %s',async actor=>{
  if(actor==='manager')db.tx.mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT 1')?[{member:true}]:sql.includes('RETURNING *')?[{id:'message-A'}]:[]}));
  await contactService.sendMessage('A','Visitor','visitor@example.test','Hello',undefined,actor);expect(analytics()).toHaveLength(0);
 });
 it('counts a visitor with no membership',async()=>{await contactService.sendMessage('A','Visitor','visitor@example.test','Hello',undefined,'visitor');expect(analytics()).toHaveLength(1);});
 it('does not count a failed message and rolls back',async()=>{
  db.tx.mockImplementation(async(sql:string)=>{if(sql.includes('contact_messages'))throw Error('storage unavailable');return {rows:[]};});
  await expect(contactService.sendMessage('A','Visitor','visitor@example.test','Hello')).rejects.toThrow('storage unavailable');expect(analytics()).toHaveLength(0);expect(db.tx).toHaveBeenCalledWith('ROLLBACK');expect(db.release).toHaveBeenCalled();
 });
 it('rolls the message and notification back if analytics fails',async()=>{
  db.tx.mockImplementation(async(sql:string)=>{if(sql.includes('profile_analytics'))throw Error('analytics unavailable');return {rows:sql.includes('RETURNING *')?[{id:'message-A'}]:[]};});
  await expect(contactService.sendMessage('A','Visitor','visitor@example.test','Hello')).rejects.toThrow('analytics unavailable');expect(db.tx).toHaveBeenCalledWith('ROLLBACK');expect(db.tx).not.toHaveBeenCalledWith('COMMIT');
 });
});
