import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),ping:vi.fn()}));
vi.mock('../../src/infrastructure/database/pool.ts',()=>({default:{query:mocks.query}}));
vi.mock('../../src/infrastructure/adapters/redis-adapter.ts',()=>({redisAdapter:{ping:mocks.ping}}));
import { GET } from '../../src/api/routes/internal/health';
beforeEach(()=>{mocks.query.mockResolvedValue({rows:[{ok:1}]});mocks.ping.mockResolvedValue(true);});
it('requires both existing runtime dependencies to be healthy',async()=>{
  const r=await GET({} as any);expect(r.status).toBe(200);expect(await r.json()).toMatchObject({checks:{postgresql:true,redis:true}});
});
it('does not report Redis ready when ping returns false',async()=>{
  mocks.ping.mockResolvedValue(false);const r=await GET({} as any);expect(r.status).toBe(503);expect(await r.json()).toMatchObject({checks:{postgresql:true,redis:false}});
});
it('reports database unavailability',async()=>{
  mocks.query.mockRejectedValue(new Error('offline'));expect((await GET({} as any)).status).toBe(503);
});
