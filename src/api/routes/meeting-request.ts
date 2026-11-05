import type { RouteHandler } from '../http';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { redisAdapter } from '../../infrastructure/adapters/redis-adapter.ts';

// Native Appointment booking; no custom Python Frappe methods or new credentials.
import { saveAppointment, nativeError } from '../../application/shared/meeting-native.ts';
import { meetingTimezones } from '../../application/shared/meeting-site.ts';
import { createMeetingIcs } from '../../application/shared/meeting-ics.ts';
import { sendMeetingReceipt } from '../../application/shared/meeting-receipt.ts';
import { resolveMeetingLead, updateMeetingLead, LeadSetupError } from '../../application/shared/meeting-crm-native.ts';
const locales=['fr','en','ar','pt','es','sw','ha','yo','zh','hi'] as const;
const schema=z.object({
  country:z.enum(['CG','FR','LB']),
  firstName:z.string().trim().min(1).max(100),
  lastName:z.string().trim().min(1).max(100),
  company:z.string().trim().min(2).max(160),
  email:z.union([z.string().trim().email().max(254),z.literal('')]).optional().default(''),
  whatsapp:z.string().regex(/^\+[1-9]\d{6,14}$/),
  reason:z.enum(['discover','partner','visibility','digital','demo','institutional','other']),
  details:z.string().max(2000).optional().default(''),
  platform:z.enum(['meet','zoom','teams']),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone:z.string().min(3).max(64),
  locale:z.enum(locales),
  reference:z.string().max(256).optional().default(''),
  website:z.string().max(512).optional().default('')
}).strict();

export const POST:RouteHandler=async ({request})=>{
  const json=(body:unknown,status:number)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(!request.headers.get('content-type')?.includes('application/json'))return json({ok:false,error:'Invalid request'},415);
  const raw=await request.text();
  if(raw.length>10000)return json({ok:false,error:'Payload too large'},413);
  let data:unknown;
  try{data=JSON.parse(raw)}catch{return json({ok:false,error:'Invalid JSON'},400)}
  const parsed=schema.safeParse(data);
  if(!parsed.success)return json({ok:false,error:'Invalid fields'},400);
  const value=parsed.data;
  if(value.website)return json({ok:true},200); // honeypot
  // Validate IANA time zone and requested future local datetime.
  try{
    if(value.timezone!==meetingTimezones[value.country])return json({ok:false,error:'INVALID_TIMEZONE'},400);
    new Intl.DateTimeFormat('en',{timeZone:value.timezone});
    const day=new Date(value.date+'T12:00:00Z');
    if(!Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==value.date)return json({ok:false,error:'Invalid date'},400);
    const today=new Date().toISOString().slice(0,10);
    if(value.date<today)return json({ok:false,error:'Date in the past'},400);
  }catch{return json({ok:false,error:'Invalid timezone'},400)}

  // Public endpoint: fail closed if distributed rate limiting is unavailable.
  try {
    const phoneKey=createHash('sha256').update(value.whatsapp).digest('hex');
    const allowed=await redisAdapter.checkRateLimit('meeting-request:phone:'+phoneKey,4,3600);
    if(!allowed)return json({ok:false,error:'Too many requests'},429);
  }catch{return json({ok:false,error:'Request temporarily unavailable'},503)}

  try {
    // Native Appointment.before_insert() calls link_customer_lead().
    // Supply a qualified Lead before that hook, otherwise Frappe may try
    // to create a Lead without the mandatory Konektag commercial axis.
    const lead=await resolveMeetingLead(value,value.country);
    const appointment=await saveAppointment(value,lead.name,value.country);
    // The Appointment is authoritative; subsequent CRM stage updates should
    // not report a booking failure or invite the customer to submit twice.
    let crmSynced=false;
    try{
      await updateMeetingLead(lead,appointment.name,value,value.country);
      crmSynced=true;
    }catch(crmError){
      console.error('[meeting-request] Appointment booked but Lead stage update failed',appointment.name,crmError);
    }
    const ics=createMeetingIcs(appointment.name,value.date,value.time,meetingTimezones[value.country]);
    // Sending is best-effort and must never turn a successful Appointment into a failed response.
    let emailSent=false;
    if(value.email){
      try{
        emailSent=await sendMeetingReceipt({
          id:appointment.name,date:value.date,time:value.time,timezone:meetingTimezones[value.country],
          firstName:value.firstName,email:value.email,locale:value.locale
        },ics);
        if(!emailSent)console.error('[meeting-request] Receipt email not accepted',appointment.name);
      }catch(mailError){
        console.error('[meeting-request] Receipt email failed',appointment.name,mailError);
      }
    }
    return json({ok:true,id:appointment.name,ics,crmSynced,emailSent},201);
  }catch(error){
    console.error('[meeting-request] ERPNext native Appointment refused',error);
    if(error instanceof LeadSetupError)
      return json({ok:false,error:'BOOKING_UNAVAILABLE'},503);
    const code=nativeError(error).code;
    return json({ok:false,error:code},code==='SLOT_UNAVAILABLE'||code==='DAY_UNAVAILABLE'?409:
      code==='DATE_UNAVAILABLE'?422:503);
  }
};
