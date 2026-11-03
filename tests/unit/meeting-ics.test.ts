import { describe, expect, it, vi } from 'vitest';
import { createMeetingIcs } from '../../src/application/shared/meeting-ics.ts';

describe('meeting calendar download (RFC5545)',()=>{
  it('uses real CRLF delimiters and a standard UTC DTSTAMP',()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T14:02:35.142Z'));
    try{
      const ics=createMeetingIcs('APMT-0008','2026-10-26','09:00','Africa/Brazzaville');
      expect(ics).toContain('\r\nBEGIN:VEVENT\r\n');
      expect(ics).not.toContain('\\r\\n');
      expect(ics).toContain('DTSTAMP:20261023T140235Z\r\n');
      expect(ics).toContain('DTSTART;TZID=Africa/Brazzaville:20261026T090000\r\n');
      expect(ics).toContain('DTEND;TZID=Africa/Brazzaville:20261026T093000\r\n');
      expect(ics).toContain('STATUS:TENTATIVE\r\n');
      expect(ics).toMatch(/\r\nEND:VCALENDAR\r\n$/);
    }finally{vi.useRealTimers();}
  });
  it('rolls the end time over midnight',()=>{
    const ics=createMeetingIcs('APMT-0010','2026-10-26','23:45','Africa/Brazzaville');
    expect(ics).toContain('DTEND;TZID=Africa/Brazzaville:20261027T001500');
  });
  it('folds long lines on RFC5545 octet boundaries',()=>{
    const content=createMeetingIcs('APMT-0008','2026-10-26','09:00','Africa/Brazzaville');
    for(const line of content.split('\r\n'))expect(Buffer.byteLength(line,'utf8')).toBeLessThanOrEqual(75);
  });
});
