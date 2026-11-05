/** Explicit legal-entity dispatch for commercial meetings. Never use the global ERPNext default. */
export type MeetingCountry = 'CG' | 'FR' | 'LB';
export const meetingCountries = ['CG','FR','LB'] as const;
export const meetingTimezones: Record<MeetingCountry,string> = {
  CG:'Africa/Brazzaville', FR:'Europe/Paris', LB:'Asia/Beirut'
};
export function isMeetingCountry(value:unknown):value is MeetingCountry {
  return typeof value==='string' && meetingCountries.includes(value as MeetingCountry);
}
type Client = {
  get:(doctype:string,name:string)=>Promise<any>;
  query:(doctype:string,filters:Array<[string,string,unknown]>,fields:string[],limit?:number)=>Promise<any>;
  create:(doctype:string,doc:Record<string,unknown>)=>Promise<any>;
  update:(doctype:string,name:string,doc:Record<string,unknown>)=>Promise<any>;
};
export function meetingErpnext(country:MeetingCountry):Client {
  if(!isMeetingCountry(country)) throw Error('INVALID_MEETING_COUNTRY');
  const prefix='ERPNEXT_'+country+'_';
  const origin=process.env[prefix+'URL'];
  const key=process.env[prefix+'API_KEY'];
  const secret=process.env[prefix+'API_SECRET'];
  if(!origin||!key||!secret) throw Error('MEETING_SITE_NOT_CONFIGURED');
  const base=new URL(origin);
  if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/')
    throw Error('MEETING_SITE_NOT_CONFIGURED');
  if(base.protocol==='http:'&&!['localhost','127.0.0.1'].includes(base.hostname)&&!base.hostname.endsWith('.svc.cluster.local'))
    throw Error('MEETING_SITE_NOT_CONFIGURED');
  const run=async(method:string,path:string,body?:unknown):Promise<any>=>{
    const res=await fetch(new URL(path,base),{
      method,headers:{'Accept':'application/json','Content-Type':'application/json','Authorization':'token '+key+':'+secret},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(10000),redirect:'manual'
    });
    if(!res.ok) throw Error('MEETING_ERP_HTTP_'+res.status);
    const data=await res.json();
    return data.data??data.message??data;
  };
  const resource=(doctype:string)=>'/api/resource/'+encodeURIComponent(doctype);
  return {
    get:(d,n)=>run('GET',resource(d)+'/'+encodeURIComponent(n)),
    query:(d,filters,fields,limit=500)=>{
      const p=new URLSearchParams({filters:JSON.stringify(filters),fields:JSON.stringify(fields),limit_page_length:String(limit)});
      return run('GET',resource(d)+'?'+p);
    },
    create:(d,doc)=>run('POST',resource(d),{doctype:d,...doc}),
    update:(d,n,doc)=>run('PUT',resource(d)+'/'+encodeURIComponent(n),doc)
  };
}
