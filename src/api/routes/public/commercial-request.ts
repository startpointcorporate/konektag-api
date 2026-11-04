import type { RouteHandler } from "../../http";
import { z } from "zod";
import { createHash } from "node:crypto";
import { redisAdapter } from "../../../infrastructure/adapters/redis-adapter.ts";
import { erpnext } from "../../../infrastructure/adapters/erpnext-adapter.ts";
import { emailService } from "../../../application/services/resend-service.ts";

const schema=z.object({
  kind:z.enum(["contact","meeting"]),locale:z.enum(["fr","en"]),
  name:z.string().trim().min(2).max(160),company:z.string().trim().min(2).max(160),
  email:z.string().trim().email().max(254),phone:z.string().trim().max(35).optional().default(""),
  country:z.string().trim().min(2).max(100),message:z.string().trim().min(3).max(2000),
  requestedDate:z.string().optional().default(""),requestedTime:z.string().optional().default(""),
  timezone:z.string().optional().default(""),website:z.string().max(200).optional().default(""),
  turnstileToken:z.string().min(1).max(2048),
}).strict();
type Input=z.infer<typeof schema>;
const reply=(body:unknown,status:number)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]||c));
const standardDate=()=>new Date().toISOString().slice(0,10);

function validateMeeting(v:Input):boolean {
  if(v.kind!=="meeting")return true;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v.requestedDate)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.requestedTime))return false;
  const date=new Date(v.requestedDate+"T12:00:00Z");
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==v.requestedDate||v.requestedDate<standardDate())return false;
  try{new Intl.DateTimeFormat("en",{timeZone:v.timezone});}catch{return false;}
  return true;
}

function receipt(v:Input,leadId:string){
  const fr=v.locale==="fr",meeting=v.kind==="meeting";
  const subject=meeting
    ? fr?"Konektag — demande de rendez-vous reçue":"Konektag — meeting request received"
    : fr?"Konektag — demande de contact reçue":"Konektag — contact request received";
  const status=meeting
    ? fr?"Votre demande a été enregistrée. Le créneau souhaité n'est pas confirmé : notre équipe vous contactera."
        :"Your request has been recorded. Your preferred time is not confirmed; our team will contact you."
    : fr?"Votre message a été reçu. Notre équipe reviendra vers vous.":"Your message has been received. Our team will get back to you.";
  const preference=meeting?"<p>"+escapeHtml(v.requestedDate+" "+v.requestedTime+" ("+v.timezone+")")+"</p>":"";
  return {subject,html:'<!doctype html><html lang="'+v.locale+'"><body style="font-family:Arial,sans-serif;background:#f7f3ff;padding:24px"><main style="max-width:580px;margin:auto;background:#fff;border-radius:16px;padding:28px"><h1>Konektag</h1><p>'+(fr?"Bonjour ":"Hello ")+escapeHtml(v.name)+',</p><p>'+escapeHtml(status)+'</p>'+preference+'<p style="font-size:12px;color:#536077">'+(fr?"Référence":"Reference")+": "+escapeHtml(leadId)+'</p></main></body></html>'};
}

async function verifyCaptcha(token:string,request:Request):Promise<boolean>{
  const secret=process.env.TURNSTILE_SECRET_KEY;
  if(!secret)return false;
  const body=new URLSearchParams({secret,response:token});
  const response=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body,
    signal:AbortSignal.timeout(7000),
  });
  if(!response.ok)return false;
  const result=await response.json() as {success?:boolean;hostname?:string;action?:string};
  const host=process.env.KONEKTAG_WEB_PUBLIC_HOST||"design.konektag.eu";
  return result.success===true && result.hostname===host && result.action==="commercial-request";
}

export const POST:RouteHandler=async ({request})=>{
  if(!request.headers.get("content-type")?.includes("application/json"))return reply({ok:false,error:"BAD_CONTENT_TYPE"},415);
  const raw=await request.text();
  if(raw.length>12000)return reply({ok:false,error:"PAYLOAD_TOO_LARGE"},413);
  let input:unknown;
  try{input=JSON.parse(raw);}catch{return reply({ok:false,error:"BAD_JSON"},400);}
  const parsed=schema.safeParse(input);
  if(!parsed.success||!validateMeeting(parsed.data))return reply({ok:false,error:"BAD_FIELDS"},400);
  const v=parsed.data;
  if(v.website)return reply({ok:false,error:"SPAM_REJECTED"},400);
  if(!process.env.RESEND_API_KEY||!process.env.KONEKTAG_MEETING_LEAD_OWNER||!process.env.KONEKTAG_MEETING_DEFAULT_AXIS||!process.env.TURNSTILE_SECRET_KEY)
    return reply({ok:false,error:"SERVICE_UNAVAILABLE"},503);
  try{
    const allowed=await redisAdapter.checkRateLimit("commercial-request:"+createHash("sha256").update(v.email).digest("hex"),4,3600);
    if(!allowed)return reply({ok:false,error:"RATE_LIMITED"},429);
  }catch{return reply({ok:false,error:"SERVICE_UNAVAILABLE"},503);}
  try{if(!await verifyCaptcha(v.turnstileToken,request))return reply({ok:false,error:"INVALID_VERIFICATION"},403);}
  catch{return reply({ok:false,error:"VERIFICATION_UNAVAILABLE"},503);}
  let leadId:string;
  try{
    const matches=await erpnext.query("Lead",[["email_id","=",v.email]],["name","custom_activity_summary"],3) as Array<{name:string;custom_activity_summary?:string}>;
    if(matches.length>1)return reply({ok:false,error:"CRM_AMBIGUOUS"},409);
    const summary=(v.kind==="meeting"?"Demande de rendez-vous":"Demande de contact")+" — "+v.country+
      ". "+v.message+(v.kind==="meeting"?"\nCréneau souhaité : "+v.requestedDate+" "+v.requestedTime+" ("+v.timezone+") — non confirmé.":"");
    if(matches.length===1){
      leadId=matches[0].name;
      await erpnext.update("Lead",leadId,{
        custom_activity_summary:((matches[0].custom_activity_summary||"")+"\n\n"+summary).slice(-12000),
        custom_next_action:v.kind==="meeting"?"Contacter et confirmer la demande de rendez-vous":"Répondre à la demande de contact",
        custom_next_action_date:v.kind==="meeting"?v.requestedDate:standardDate(),
      });
    }else{
      const created=await erpnext.create("Lead",{
        lead_name:v.name,company_name:v.company,email_id:v.email,mobile_no:v.phone||undefined,
        lead_owner:process.env.KONEKTAG_MEETING_LEAD_OWNER,
        custom_axis:process.env.KONEKTAG_MEETING_DEFAULT_AXIS,
        custom_commercial_stage:"À rechercher",
        custom_next_action:v.kind==="meeting"?"Confirmer la demande de rendez-vous":"Répondre à la demande de contact",
        custom_next_action_date:v.kind==="meeting"?v.requestedDate:standardDate(),
        custom_activity_summary:summary,
      }) as {name?:string};
      if(!created?.name)throw Error("MISSING_CRM_IDENTIFIER");
      leadId=created.name;
    }
  }catch(error){
    console.error("[commercial-request] CRM operation failed",error instanceof Error?error.name:"Error");
    return reply({ok:false,error:"CRM_UNAVAILABLE"},503);
  }
  const mail=receipt(v,leadId);
  const receiptKey=createHash("sha256").update(v.kind+"|"+v.email+"|"+v.message+"|"+v.requestedDate+"|"+v.requestedTime).digest("hex");
  const emailSent=await emailService.send({to:v.email,subject:mail.subject,html:mail.html,idempotencyKey:"commercial-request/"+receiptKey});
  if(!emailSent)console.error("[commercial-request] CRM recorded but receipt unavailable",leadId);
  return reply({ok:true,reference:leadId,emailSent},201);
};
