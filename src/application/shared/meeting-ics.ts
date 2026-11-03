/** RFC 5545 tentative appointment notice shared by download and confirmation email. */
const two=(n:number)=>String(n).padStart(2,'0');
function escapeIcs(value:string):string {
  return value.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n')
    .replace(/,/g,'\\,').replace(/;/g,'\\;');
}
function fold(line:string):string{
  const bytes=Buffer.from(line,'utf8');
  if(bytes.length<=75)return line;
  // Fold on Unicode codepoint boundaries at 75 UTF-8 octets.
  const parts:string[]=[];let segment='';let n=0;
  for(const character of line){
    const len=Buffer.byteLength(character,'utf8');
    if(n+len>75){parts.push(segment);segment=' ';n=1;}
    segment+=character;n+=len;
  }
  parts.push(segment);
  return parts.join('\r\n');
}
export function createMeetingIcs(appointmentId:string,date:string,time:string,timeZone:string):string{
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw new Error('Invalid calendar fields');
  const [h,m]=time.split(':').map(Number);
  const start=new Date(date+'T00:00:00Z');
  const end=new Date(start.getTime()+(h*60+m+30)*60000);
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const startText=date.replace(/-/g,'')+'T'+two(h)+two(m)+'00';
  const endText=end.toISOString().slice(0,10).replace(/-/g,'')+'T'+
    two(end.getUTCHours())+two(end.getUTCMinutes())+'00';
  const lines=[
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Konektag//Appointment//FR',
    'CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT',
    'UID:'+escapeIcs(appointmentId+'@konektag.eu'),
    'DTSTAMP:'+stamp,
    'DTSTART;TZID='+timeZone+':'+startText,
    'DTEND;TZID='+timeZone+':'+endText,
    'STATUS:TENTATIVE','TRANSP:TRANSPARENT',
    'SUMMARY:'+escapeIcs('Demande de rendez-vous Konektag (en attente de confirmation)'),
    'DESCRIPTION:'+escapeIcs('Votre demande a été enregistrée. Ce rendez-vous reste à confirmer.'),
    'END:VEVENT','END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n')+'\r\n';
}
