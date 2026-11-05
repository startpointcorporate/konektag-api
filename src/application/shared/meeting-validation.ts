import { z } from 'zod';

/** Native ERPNext Appointment.customer_email is mandatory; never accept blank. */
export const meetingEmailSchema = z.string().trim().email().max(254);

export function requiredAppointmentEmail(email:string):string {
  const parsed=meetingEmailSchema.safeParse(email);
  if(!parsed.success)throw new Error('MEETING_EMAIL_REQUIRED');
  return parsed.data;
}
