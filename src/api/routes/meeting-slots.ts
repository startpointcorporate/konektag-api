import type { RouteHandler } from '../http';
import { z } from 'zod';
import { availableSlots, nativeError } from '../../application/shared/meeting-native.ts';

const schema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const json=(body:unknown,status:number)=>new Response(JSON.stringify(body),{
  status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}
});

export const GET:RouteHandler=async ({request})=>{
  const parsed=schema.safeParse({date:new URL(request.url).searchParams.get('date')});
  if(!parsed.success)return json({error:'DATE_UNAVAILABLE'},422);
  try{
    return json(await availableSlots(parsed.data.date),200);
  }catch(error){
    const code=nativeError(error).code;
    console.error('[meeting-slots] ERPNext availability failed', { code, errorClass:error instanceof Error?error.name:'Unknown' });
    return json({error:code, ...(code==='BOOKING_UNAVAILABLE'?{reason:'FRAPPE_BOOKING_SETTINGS_OR_ACCESS'}:{})},code==='DATE_UNAVAILABLE'?422:503);
  }
};
