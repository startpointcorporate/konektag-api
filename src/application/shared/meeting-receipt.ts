import { emailService } from '../services/resend-service.ts';
import { createMeetingIcs } from './meeting-ics.ts';

type Info={id:string;date:string;time:string;timezone:string;firstName:string;email:string;locale:string};
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,ch=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[ch]||ch));

export async function sendMeetingReceipt(info:Info,ics?:string):Promise<boolean>{
  if(!info.email)return false;
  const french=info.locale==='fr';
  const title=french?'Votre demande de rendez-vous a bien été reçue':'Your meeting request has been received';
  const status=french?
    "Le créneau est réservé pour votre demande, mais le rendez-vous n'est pas encore confirmé.":
    'This time has been reserved for your request, but the meeting is not confirmed yet.';
  const hello=french?'Bonjour':'Hello';
  const date=new Intl.DateTimeFormat(french?'fr-FR':'en-US',{
    timeZone:'UTC',dateStyle:'full'
  }).format(new Date(info.date+'T12:00:00Z'));
  const html=['<!doctype html><html><head><meta charset="utf-8"></head>',
    '<body style="font-family:Arial,sans-serif;background:#081824;color:#202a32;padding:26px">',
    '<div style="max-width:580px;margin:auto;background:#fff;border-radius:16px;padding:30px">',
    '<h1 style="color:#0b2231">Konektag</h1><h2>'+escapeHtml(title)+'</h2>',
    '<p>'+hello+' '+escapeHtml(info.firstName)+',</p>',
    '<p>'+escapeHtml(status)+'</p>',
    '<p><strong>'+escapeHtml(date)+' — '+escapeHtml(info.time)+' ('+escapeHtml(info.timezone)+')</strong></p>',
    '<p>'+(french?'Vous trouverez en pièce jointe un fichier calendrier provisoire.':'A tentative calendar file is attached.')+'</p>',
    '<p>'+(french?'Nous vous contacterons pour confirmer le rendez-vous.':'We will contact you to confirm the meeting.')+'</p>',
    '<p style="color:#667;font-size:12px">Konektag • '+escapeHtml(info.id)+'</p>',
    '</div></body></html>'
  ].join('');
  return emailService.send({
    to:info.email,
    subject:'Konektag — '+title,
    html,
    idempotencyKey:'meeting-receipt/'+info.id,
    attachments:[{
      filename:'konektag-demande-rendez-vous.ics',
      content:Buffer.from(ics??createMeetingIcs(info.id,info.date,info.time,info.timezone),'utf8').toString('base64'),
      contentType:'text/calendar; charset=utf-8',
    }],
  });
}
