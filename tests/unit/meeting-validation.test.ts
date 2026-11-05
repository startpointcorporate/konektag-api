import { describe, expect, it } from 'vitest';
import { meetingEmailSchema, requiredAppointmentEmail } from '../../src/application/shared/meeting-validation.ts';

describe('ERPNext mandatory Appointment email',()=>{
  it('rejects empty and whitespace-only emails before ERPNext insertion',()=>{
    for(const email of ['', '   ', 'not-an-email']){
      expect(meetingEmailSchema.safeParse(email).success).toBe(false);
      expect(()=>requiredAppointmentEmail(email)).toThrow('MEETING_EMAIL_REQUIRED');
    }
  });
  it('accepts and normalizes an email usable by Appointment and Lead',()=>{
    expect(requiredAppointmentEmail(' person@example.com ')).toBe('person@example.com');
  });
});
