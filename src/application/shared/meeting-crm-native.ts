/** Native ERPNext Lead resolution for the three independent Konektag sites.
 * Do not assume custom_axis/custom_commercial_stage exist: some ERPNext
 * installations expose only standard Lead fields, as audited on Congo.
 */
import { meetingErpnext, type MeetingCountry } from './meeting-site.ts';
import { requiredAppointmentEmail } from './meeting-validation.ts';

export type MeetingForm={
  firstName:string;lastName:string;company:string;email:string;whatsapp:string;
  date:string;time:string;timezone:string;reason:string;details:string;platform:string;
  locale:string;reference:string;
};
export type LeadRecord={name:string};

export class LeadSetupError extends Error {
  constructor(message:string){super(message);this.name='LeadSetupError';}
}

/** Reuse an unambiguous Lead or create one in the explicitly selected site.
 * Native Appointment links to this Lead. No custom CRM fields are written.
 */
export async function resolveMeetingLead(d:MeetingForm,country:MeetingCountry):Promise<LeadRecord>{
  const email=requiredAppointmentEmail(d.email);
  const erpnext=meetingErpnext(country);
  const matching:LeadRecord[]=[];
  const byPhone=await erpnext.query('Lead',
    [['mobile_no','=',d.whatsapp]],['name'],5) as LeadRecord[];
  matching.push(...byPhone);
  const byEmail=await erpnext.query('Lead',
    [['email_id','=',email]],['name'],5) as LeadRecord[];
  for(const lead of byEmail)if(!matching.some(l=>l.name===lead.name))matching.push(lead);
  if(matching.length>1)
    throw new LeadSetupError('Ambiguous Lead match: manual reconciliation required');
  if(matching.length===1)return matching[0];

  const owner=process.env['KONEKTAG_MEETING_'+country+'_LEAD_OWNER'];
  if(!owner)throw new LeadSetupError('Missing country-specific Lead owner');

  const created=await erpnext.create('Lead',{
    lead_name:d.firstName+' '+d.lastName,
    company_name:d.company,
    email_id:email,
    mobile_no:d.whatsapp,
    lead_owner:owner
  }) as LeadRecord;
  if(!created?.name)throw new LeadSetupError('Lead creation returned no document name');
  return created;
}
