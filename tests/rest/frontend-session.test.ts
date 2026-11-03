import { beforeEach, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/api/router';
const m = vi.hoisted(() => ({ query:vi.fn(),validateToken:vi.fn(),refreshToken:vi.fn(),getUser:vi.fn(),authenticate:vi.fn() }));
vi.mock('../../src/infrastructure/database/pool',()=>({default:{query:m.query}}));
vi.mock('../../src/application/services/auth-service',()=>({authService:m}));
vi.mock('../../src/application/services/user-api-key-service',()=>({userApiKeyService:{authenticate:m.authenticate}}));
vi.mock('../../src/application/services/merchant-api-key-service',()=>({merchantApiKeyService:{}}));
vi.mock('../../src/infrastructure/adapters/keycloak-adapter',()=>({keycloakAdapter:m}));
vi.mock('../../src/infrastructure/adapters/encryption-service',()=>({encryptionService:{decrypt:vi.fn()}}));
import { onRequest } from '../../src/api/middleware/security';
const profile={id:'user-1',keycloak_id:'kc-owner',username:'ada.test',locale:'fr',state:'COMPLETED',role:'user',email_verified:true};
const read=(cookie='',authorization='')=>dispatch(new Request('https://api.invalid/api/auth/me',{headers:{cookie,authorization}}),'127.0.0.1',onRequest);
beforeEach(()=>{
 vi.resetAllMocks(); m.query.mockResolvedValue({rows:[profile]}); m.getUser.mockResolvedValue({firstName:'Ada',lastName:'Test',email:'ada@example.invalid'});
 m.validateToken.mockResolvedValue({sub:'kc-owner',email:'ada@example.invalid'});
 m.refreshToken.mockResolvedValue({accessToken:'new-access',refreshToken:'new-refresh'});
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Unmocked network forbidden');}));
});
it('reads the frontend profile through the real router and session middleware',async()=>{
 const response=await read('konektag_access_token=valid-access'); expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({username:'ada.test',firstName:'Ada',email:'ada@example.invalid',emailVerified:true});
 expect(m.validateToken).toHaveBeenCalledWith('valid-access'); expect(m.getUser).toHaveBeenCalledWith('kc-owner');
 for(const [,params] of m.query.mock.calls)expect(params).toEqual(['kc-owner']);
 expect(response.headers.getSetCookie()).toEqual([]);
});
it('refreshes an expired access cookie and emits two compatible session cookies',async()=>{
 m.validateToken.mockImplementation(async token=>{if(token==='expired')throw new Error('expired');return {sub:'kc-owner'};});
 const response=await read('konektag_access_token=expired; konektag_refresh_token=valid-refresh');
 expect(response.status).toBe(200); expect(await response.json()).toMatchObject({username:'ada.test'}); expect(m.refreshToken).toHaveBeenCalledWith('valid-refresh');
 const cookies=response.headers.getSetCookie(); expect(cookies).toHaveLength(2);
 expect(cookies[0]).toContain('konektag_access_token=new-access'); expect(cookies[1]).toContain('konektag_refresh_token=new-refresh');
 for(const cookie of cookies){expect(cookie).toContain('HttpOnly');expect(cookie).toContain('Secure');expect(cookie).toContain('SameSite=Lax');expect(cookie).toContain('Path=/');}
});
it('refuses anonymous profile reads without calling Keycloak or PostgreSQL',async()=>{
 const response=await read(); expect(response.status).toBe(401); expect(m.query).not.toHaveBeenCalled();expect(m.getUser).not.toHaveBeenCalled();
});
it('does not fall back to a valid session cookie after invalid personal API credentials',async()=>{
 m.authenticate.mockResolvedValue(null); const response=await read('konektag_access_token=valid-access','token invalid:invalid');
 expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'INVALID_API_CREDENTIALS'});expect(m.query).not.toHaveBeenCalled();expect(m.validateToken).not.toHaveBeenCalled();
});
