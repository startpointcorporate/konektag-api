/** Native ERPNext Appointment inventory via existing REST token. No Frappe app deployment. */
import { meetingErpnext, meetingTimezones, type MeetingCountry } from './meeting-site.ts';

type Slot = {time: string};
type BookingSettings = {
  enable_scheduling: number; appointment_duration: number; number_of_agents: number;
  advance_booking_days: number; holiday_list?: string | null;
  agent_list?: Array<{user:string}>;
  availability_of_slots?: Array<{day_of_week:string;from_time:string;to_time:string}>;
};
type Appointment = { name: string; scheduled_time: string; status: string; calendar_event?: string | null };
type EventRecord = { name:string; starts_on:string; ends_on:string; status:string };

// Each legal entity operates its own appointment timezone.
const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const calendarDay = (value:string): Date => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BookingError('DATE_UNAVAILABLE');
  const date = new Date(value+'T00:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value) throw new BookingError('DATE_UNAVAILABLE');
  return date;
};
const timeMins=(value:unknown):number=>{
  const s=String(value ?? '');
  const match=/^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if(!match)throw new BookingError('BOOKING_UNAVAILABLE');
  return Number(match[1])*60+Number(match[2]);
};
const pad=(n:number)=>String(n).padStart(2,'0');
const textTime=(n:number)=>pad(Math.floor(n/60))+':'+pad(n%60);
const toMinutes=(value:string)=>timeMins(value.slice(11,16));

export class BookingError extends Error{
  constructor(public code:'DATE_UNAVAILABLE'|'DAY_UNAVAILABLE'|'SLOT_UNAVAILABLE'|'BOOKING_UNAVAILABLE'){
    super(code);
  }
}
export function nativeError(error:unknown):BookingError{
  if(error instanceof BookingError)return error;
  const str=String(error);
  if(/Time slot is not available|overlap|already booked|appointment.*occupied|SLOT_UNAVAILABLE/i.test(str))
    return new BookingError('SLOT_UNAVAILABLE');
  if(/Holiday|holiday|DAY_UNAVAILABLE/i.test(str))return new BookingError('DAY_UNAVAILABLE');
  if(/backdated|advance|past date|date.*invalid|DATE_UNAVAILABLE/i.test(str))
    return new BookingError('DATE_UNAVAILABLE');
  return new BookingError('BOOKING_UNAVAILABLE');
}
const getSettings=async(erpnext:ReturnType<typeof meetingErpnext>):Promise<BookingSettings>=>{
  const s=await erpnext.get('Appointment Booking Settings','Appointment Booking Settings') as BookingSettings;
  if(!s||Number(s.enable_scheduling)!==1||Number(s.appointment_duration)!==30||
    ![1,2].includes(Number(s.number_of_agents))||!Array.isArray(s.agent_list)||s.agent_list.length<Number(s.number_of_agents)||!Array.isArray(s.availability_of_slots))
    throw new BookingError('BOOKING_UNAVAILABLE');
  return s;
};
async function getAppointments(day:string,erpnext:ReturnType<typeof meetingErpnext>):Promise<Appointment[]>{
  const list=await erpnext.query('Appointment',[
    ['scheduled_time','between',[day+' 00:00:00',day+' 23:59:59']],
    ['status','!=','Closed'],
  ],['name','scheduled_time','status','calendar_event'],501) as Appointment[];
  if(!Array.isArray(list)||list.length>500)throw new BookingError('BOOKING_UNAVAILABLE');
  return list;
}
async function getEvents(day:string,erpnext:ReturnType<typeof meetingErpnext>):Promise<EventRecord[]>{
  // Includes one-off blocking events created from Frappe's normal calendar.
  const events=await erpnext.query('Event',[
    ['starts_on','<',day+' 23:59:59'],
    ['ends_on','>',day+' 00:00:00'],
    ['status','not in',['Cancelled','Closed']],
  ],['name','starts_on','ends_on','status'],501) as EventRecord[];
  if(!Array.isArray(events)||events.length>500)throw new BookingError('BOOKING_UNAVAILABLE');
  return events;
}
async function isHoliday(day:string,listName:string|null|undefined,erpnext:ReturnType<typeof meetingErpnext>):Promise<boolean>{
  if(!listName)throw new BookingError('BOOKING_UNAVAILABLE');
  const holidayList=await erpnext.get('Holiday List',listName) as {holidays?:Array<{holiday_date:string}>};
  if(!Array.isArray(holidayList.holidays))throw new BookingError('BOOKING_UNAVAILABLE');
  return holidayList.holidays.some(h=>h.holiday_date===day);
}
function intersects(a:number,b:number,x:number,y:number){return a<y&&b>x;}

export async function availableSlots(dateString:string,country:MeetingCountry):Promise<{date:string; timezone:string; duration_minutes:30; slots:Slot[]}>{
  const day=calendarDay(dateString);
  const erpnext=meetingErpnext(country);
  const timezone=meetingTimezones[country];
  const settings=await getSettings(erpnext);
  // ERPNext advance_booking_days is a MAXIMUM advance window, not a minimum.
  const todayParts=new Intl.DateTimeFormat('en-US',{
    timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(new Date());
  const datePart=(type:string)=>todayParts.find(part=>part.type===type)?.value||'';
  const localToday=datePart('year')+'-'+datePart('month')+'-'+datePart('day');
  const offset=Math.floor((day.getTime()-calendarDay(localToday).getTime())/86400000);
  if(offset<0||offset>Number(settings.advance_booking_days||0))throw new BookingError('DATE_UNAVAILABLE');
  const dayName=weekdays[day.getUTCDay()];
  const windows=(settings.availability_of_slots||[]).filter(x=>x.day_of_week===dayName);
  if(!windows.length||await isHoliday(dateString,settings.holiday_list,erpnext))
    return {date:dateString,timezone,duration_minutes:30,slots:[]};
  const [bookings,events]=await Promise.all([getAppointments(dateString,erpnext),getEvents(dateString,erpnext)]);
  // One appointment consumes one agent, not the entire site calendar.
  // ERPNext makes the final per-agent assignment and overlap validation at insert.
  const taken=bookings.map(x=>toMinutes(x.scheduled_time));
  const capacity=Number(settings.number_of_agents);
  // ERPNext creates one Event per Appointment. Counting that Event again would\n  // hide the second agent's remaining capacity at the same time.\n  const appointmentEvents=new Set(bookings.map(b=>b.calendar_event).filter(Boolean));\n  const blocks=events.filter(e=>!appointmentEvents.has(e.name)).map(e=>({
    from:e.starts_on.slice(0,10)<dateString?0:toMinutes(e.starts_on),
    to:e.ends_on.slice(0,10)>dateString?1440:toMinutes(e.ends_on),
  }));
  const options=new Set<number>();
  for(const row of windows){
    const start=timeMins(row.from_time),end=timeMins(row.to_time);
    for(let min=Math.ceil(start/30)*30;min+30<=end;min+=30){
      if(taken.filter(t=>intersects(min,min+30,t,t+30)).length>=capacity)continue;
      if(blocks.some(b=>intersects(min,min+30,b.from,b.to)))continue;
      options.add(min);
    }
  }
  return {date:dateString,timezone,duration_minutes:30,slots:[...options].sort((a,b)=>a-b).map(n=>({time:textTime(n)}))};
}
export async function saveAppointment(data:{
  date:string;time:string;firstName:string;lastName:string;email:string;whatsapp:string;
  company:string;reason:string;details:string;platform:string;
}, leadName:string,country:MeetingCountry):Promise<{name:string;scheduled_time:string}>{
  // Refresh inventory before the native insert: native Appointment validates it again.
  const erpnext=meetingErpnext(country);
  const availability=await availableSlots(data.date,country);
  if(!availability.slots.some(s=>s.time===data.time))throw new BookingError('SLOT_UNAVAILABLE');
  const description=[
    'Demande de rendez-vous Konektag — en attente de confirmation',
    'Société : '+data.company,'Motif : '+data.reason,
    'Canal souhaité : '+data.platform,'Détails : '+data.details,
  ].join('\\n');
  const inserted=await erpnext.create('Appointment',{
    scheduled_time:data.date+' '+data.time+':00',
    status:'Open',
    customer_name:data.firstName+' '+data.lastName,
    customer_phone_number:data.whatsapp,
    customer_email:data.email||undefined,
    customer_details:description,
    appointment_with:'Lead',
    party:leadName,
  }) as {name?:string;scheduled_time?:string};
  if(!inserted?.name)throw new BookingError('BOOKING_UNAVAILABLE');
  return {name:inserted.name,scheduled_time:inserted.scheduled_time||data.date+' '+data.time+':00'};
}
