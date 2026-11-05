import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMeetingCountry, meetingErpnext, meetingTimezones } from '../../src/application/shared/meeting-site.ts';

const keys=['CG','FR','LB'] as const;
afterEach(()=>{
  for(const c of keys){
    delete process.env['ERPNEXT_'+c+'_URL'];
    delete process.env['ERPNEXT_'+c+'_API_KEY'];
    delete process.env['ERPNEXT_'+c+'_API_SECRET'];
  }
  vi.unstubAllGlobals();
});
describe('country-scoped meeting dispatch',()=>{
  it('rejects absent, unknown and unsupported countries',()=>{
    expect(isMeetingCountry(undefined)).toBe(false);
    expect(isMeetingCountry('')).toBe(false);
    expect(isMeetingCountry('US')).toBe(false);
    for(const c of keys) expect(isMeetingCountry(c)).toBe(true);
  });
  it('requires entity-specific credentials, never the global ERPNext credentials',()=>{
    process.env.ERPNEXT_URL='https://legacy.example';
    process.env.FRAPPE_API_KEY='legacy';
    process.env.FRAPPE_API_SECRET='legacy';
    expect(()=>meetingErpnext('FR')).toThrow('MEETING_SITE_NOT_CONFIGURED');
  });
  it('queries the requested entity and does not reuse other entity credentials',async()=>{
    for(const c of keys){
      process.env['ERPNEXT_'+c+'_URL']='https://erp-'+c.toLowerCase()+'.example/';
      process.env['ERPNEXT_'+c+'_API_KEY']='key-'+c;
      process.env['ERPNEXT_'+c+'_API_SECRET']='secret-'+c;
    }
    const calls:Array<{url:string;auth:string}>=[];
    vi.stubGlobal('fetch',vi.fn(async(input:URL,init:RequestInit)=>{
      calls.push({url:String(input),auth:String((init.headers as Record<string,string>).Authorization)});
      return new Response(JSON.stringify({data:{name:'Appointment Booking Settings'}}),{status:200});
    }));
    for(const c of keys)await meetingErpnext(c).get('Appointment Booking Settings','Appointment Booking Settings');
    expect(calls).toHaveLength(3);
    for(const [i,c] of keys.entries()){
      expect(calls[i].url).toContain('erp-'+c.toLowerCase()+'.example');
      expect(calls[i].auth).toBe('token key-'+c+':secret-'+c);
    }
  });
  it('provides the actual timezone for each legal entity',()=>{
    expect(meetingTimezones).toEqual({CG:'Africa/Brazzaville',FR:'Europe/Paris',LB:'Asia/Beirut'});
  });
});
