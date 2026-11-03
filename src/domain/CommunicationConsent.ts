export type ConsentChannel = 'email' | 'sms' | 'push' | 'whatsapp';

export type ConsentStatus = 'granted' | 'denied';

export type ConsentSource = 'onboarding' | 'settings' | 'unsubscribe_link' | 'whatsapp_optout' | 'admin';

export interface CommunicationConsent {
  id: string;
  userId: string;
  channel: ConsentChannel;
  status: ConsentStatus;
  source: ConsentSource;
  ipAddress: string | null;
  grantedAt: Date;
  updatedAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
  version: number;
}

export interface CommunicationConsentRow {
  id: string;
  user_id: string;
  channel: ConsentChannel;
  status: ConsentStatus;
  source: ConsentSource;
  ip_address: string | null;
  granted_at: Date;
  updated_at: Date;
  created_at: Date;
  deleted_at: Date | null;
  version: number;
}

export const ALL_CHANNELS: ConsentChannel[] = ['email', 'sms', 'push', 'whatsapp'];

export const DEFAULT_CONSENT_STATUS: ConsentStatus = 'granted';

export function isConsentChannel(value: string): value is ConsentChannel {
  return ALL_CHANNELS.includes(value as ConsentChannel);
}
