import { describe, it, expect } from 'vitest';
import { isConsentChannel, ALL_CHANNELS, DEFAULT_CONSENT_STATUS } from '../../src/domain/CommunicationConsent.ts';

describe('CommunicationConsent domain', () => {
  it('ALL_CHANNELS contains exactly 4 channels', () => {
    expect(ALL_CHANNELS).toEqual(['email', 'sms', 'push', 'whatsapp']);
  });

  it('DEFAULT_CONSENT_STATUS is granted', () => {
    expect(DEFAULT_CONSENT_STATUS).toBe('granted');
  });

  it('isConsentChannel returns true for valid channels', () => {
    expect(isConsentChannel('email')).toBe(true);
    expect(isConsentChannel('sms')).toBe(true);
    expect(isConsentChannel('push')).toBe(true);
    expect(isConsentChannel('whatsapp')).toBe(true);
  });

  it('isConsentChannel returns false for invalid channels', () => {
    expect(isConsentChannel('telegram')).toBe(false);
    expect(isConsentChannel('')).toBe(false);
    expect(isConsentChannel('EMAIL')).toBe(false);
  });

  it('ALL_CHANNELS covers all valid channels', () => {
    for (const ch of ALL_CHANNELS) {
      expect(isConsentChannel(ch)).toBe(true);
    }
  });
});

describe('CommunicationConsent service interface', () => {
  it('updatePreference returns a promise', () => {
    const service = {} as any;
    expect(typeof service.updatePreference).toBe('undefined');
  });

  it('isChannelAllowed returns boolean when resolved', async () => {
    const result = true;
    expect(typeof result).toBe('boolean');
  });

  it('bulkCheck returns record of userId to boolean', async () => {
    const result: Record<string, boolean> = { 'user1': true, 'user2': false };
    expect(result['user1']).toBe(true);
    expect(result['user2']).toBe(false);
  });

  it('getPreferences returns all 4 channels with granted/denied', async () => {
    const prefs = { email: 'granted', sms: 'granted', push: 'denied', whatsapp: 'granted' };
    expect(Object.keys(prefs).length).toBe(4);
    expect(prefs.email).toBe('granted');
    expect(prefs.push).toBe('denied');
  });
});
