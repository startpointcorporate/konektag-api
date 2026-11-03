import {it,expect} from 'vitest';
import {generateSigningKey,signJws} from '../../src/application/shared/core02/crypto.ts';
import {verifyRevocations} from '../../src/application/shared/core02/qr.ts';
it('accepts all 10000 supported revocations while enforcing the entry limit',async()=>{
 const pair=await generateSigningKey(),now=Math.floor(Date.now()/1000),deviceId=crypto.randomUUID();
 const payload={version:2,revision:10000,issuedAt:now,expiresAt:now+3600,entries:Array.from({length:10000},()=>({deviceId,keyId:crypto.randomUUID(),revokedAt:now}))};
 const token=await signJws(payload,pair.privateKey,'capacity','KTG-REV2');expect(token.length).toBeGreaterThan(1400000);expect(token.length).toBeLessThan(2000000);
 expect((await verifyRevocations(token,{capacity:pair.publicKey},now)).entries).toHaveLength(10000);
 const oversized=await signJws({...payload,entries:[...payload.entries,payload.entries[0]]},pair.privateKey,'capacity','KTG-REV2');
 await expect(verifyRevocations(oversized,{capacity:pair.publicKey},now)).rejects.toThrow();
});
