/**
 * Frappe site of a commercial meeting. The site is resolved once per request
 * from the residence country (see konektag-site.ts) and passed to every call,
 * so the displayed slots, the Lead and the Appointment come from the same site.
 * The former ERPNEXT_<COUNTRY>_URL / _API_KEY / _API_SECRET variables are not read.
 */
import { konektagFrappeSite, type KonektagSiteRoute } from './konektag-site.ts';

export type MeetingClient = {
  get:(doctype:string,name:string)=>Promise<any>;
  query:(doctype:string,filters:Array<[string,string,unknown]>,fields:string[],limit?:number)=>Promise<any>;
  create:(doctype:string,doc:Record<string,unknown>)=>Promise<any>;
  update:(doctype:string,name:string,doc:Record<string,unknown>)=>Promise<any>;
};

/** A routed site with its meeting client. */
export type MeetingSite = { route: KonektagSiteRoute; erpnext: MeetingClient };

export function meetingSite(route:KonektagSiteRoute, env:NodeJS.ProcessEnv=process.env, fetchImpl:typeof fetch=fetch):MeetingSite {
  const site=konektagFrappeSite(route,env,fetchImpl);
  return {
    route,
    erpnext:{
      get:(d,n)=>site.get(d,n),
      query:(d,filters,fields,limit=500)=>site.list(d,filters,fields,limit),
      create:(d,doc)=>site.insert(d,doc),
      update:(d,n,doc)=>site.update(d,n,doc),
    },
  };
}
