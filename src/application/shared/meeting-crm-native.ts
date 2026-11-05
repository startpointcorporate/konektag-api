/** Ensure the CRM Lead exists before native ERPNext Appointment.before_insert().
 * Native Appointment.link_customer_lead() otherwise creates an unqualified Lead,
 * which is rejected by Konektag's mandatory commercial axis validator.
 */
import { meetingErpnext, type MeetingCountry } from './meeting-site.ts';
import { requiredAppointmentEmail } from './meeting-validation.ts';

export type MeetingForm={
  firstName:string;lastName:string;company:string;email:string;whatsapp:string;
  date:string;time:string;timezone:string;reason:string;details:string;platform:string;
  locale:string;reference:string;
};
type LeadRecord={
  name:string;custom_axis?:string;custom_commercial_stage?:string;
  custom_activity_summary?:string;
};
const eligible=new Set(['Prendre RDV avec le décideur','Prendre RDV avec le DG',
  'À contacter','Contacté','Relancer le prospect','À rechercher','Vérifié']);

export class LeadSetupError extends Error {
  constructor(message:string){super(message);this.name='LeadSetupError';}
}

export async function resolveMeetingLead(d:MeetingForm,country:MeetingCountry):Promise<LeadRecord>{
  const email=requiredAppointmentEmail(d.email);
  const erpnext=meetingErpnext(country);
  const matching:LeadRecord[]=[];
  const byPhone=await erpnext.query('Lead',
    [['mobile_no','=',d.whatsapp]],
    ['name','custom_axis','custom_commercial_stage','custom_activity_summary'],5) as LeadRecord[];
  matching.push(...byPhone);
  if(email){
    const byEmail=await erpnext.query('Lead',
      [['email_id','=',email]],
      ['name','custom_axis','custom_commercial_stage','custom_activity_summary'],5) as LeadRecord[];
    for(const lead of byEmail)if(!matching.some(l=>l.name===lead.name))matching.push(lead);
  }
  if(matching.length!==1&&matching.length!==0){
    throw new LeadSetupError('Ambiguous Lead match: manual reconciliation required');
  }
  if(matching.length===1)return matching[0];
  // The owner/axis are business routing rules: never silently invent them.
  const axis=process.env['KONEKTAG_MEETING_'+country+'_DEFAULT_AXIS'];
  const owner=process.env['KONEKTAG_MEETING_'+country+'_LEAD_OWNER'];
  if(!axis||!owner){
    throw new LeadSetupError('Missing KONEKTAG_MEETING_DEFAULT_AXIS or KONEKTAG_MEETING_LEAD_OWNER');
  }
  const created=await erpnext.create('Lead',{
    lead_name:d.firstName+' '+d.lastName,
    company_name:d.company,email_id:email,
    mobile_no:d.whatsapp,lead_owner:owner,custom_axis:axis,
    custom_commercial_stage:'À rechercher',
    custom_next_action:'Traiter la demande de rendez-vous en ligne',
    custom_next_action_date:d.date,
  }) as LeadRecord;
  if(!created?.name)throw new LeadSetupError('Lead creation returned no document name');
  return created;
}

/** CRM progression only after a successful native Appointment insertion. */
export async function updateMeetingLead(lead:LeadRecord,appointmentName:string,d:MeetingForm,country:MeetingCountry):Promise<void>{
  const erpnext=meetingErpnext(country);
  const update:Record<string,unknown>={
    custom_activity_summary:(lead.custom_activity_summary||'')+
      '\n\nDemande du site : Appointment '+appointmentName+' le '+d.date+
      ' à '+d.time+' ('+d.timezone+'). Motif : '+d.reason+
      '. En attente de confirmation.',
  };
  if(eligible.has(lead.custom_commercial_stage||'À rechercher')){
    update.custom_commercial_stage='RDV demandé';
    update.custom_next_action='Confirmer Appointment '+appointmentName;
    update.custom_next_action_date=d.date;
  }
  await erpnext.update('Lead',lead.name,update);
}
