import type { RouteHandler } from '../http';
import { z } from 'zod';
import { availableSlots, nativeError } from '../../application/shared/meeting-native.ts';
import { meetingSite } from '../../application/shared/meeting-site.ts';
import { KonektagSiteError, konektagSiteErrorStatus, routeKonektagFlow } from '../../application/shared/konektag-site.ts';

// `country` is the visitor's residence country (ISO 3166-1 alpha-2). The API
// routes it to the Konektag entity and its Frappe site; the browser never picks a site.
const schema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), country:z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/) });
const json=(body:unknown,status:number)=>new Response(JSON.stringify(body),{
  status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}
});

export const GET:RouteHandler=async ({request})=>{
  const parsed=schema.safeParse({date:new URL(request.url).searchParams.get('date'),country:new URL(request.url).searchParams.get('country')});
  if(!parsed.success)return json({error:'INVALID_MEETING_PARAMETERS'},422);
  try{
    const route=await routeKonektagFlow('meeting-slots',parsed.data.country);
    const slots=await availableSlots(parsed.data.date,meetingSite(route));
    return json({...slots,konektagSite:route.slug},200);
  }catch(error){
    if(error instanceof KonektagSiteError){
      console.error('[meeting-slots] Frappe routing failed', { code:error.code, ...error.detail });
      return json({error:error.code},konektagSiteErrorStatus(error));
    }
    const code=nativeError(error).code;
    console.error('[meeting-slots] ERPNext availability failed', { code, errorClass:error instanceof Error?error.name:'Unknown' });
    return json({error:code, ...(code==='BOOKING_UNAVAILABLE'?{reason:'FRAPPE_BOOKING_SETTINGS_OR_ACCESS'}:{})},code==='DATE_UNAVAILABLE'?422:503);
  }
};
