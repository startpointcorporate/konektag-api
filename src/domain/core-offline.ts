export const OFFLINE_CONTRACT_VERSION = 1 as const;
export type OfflineSyncState = 'CREATED' | 'DELIVERED_TO_MERCHANT' | 'SYNC_PENDING' | 'SYNCING' |
  'SETTLED' | 'REJECTED' | 'CONFLICT' | 'REQUIRES_REVIEW';
export interface Versioned { version: typeof OFFLINE_CONTRACT_VERSION }
export interface SignedEnvelope extends Versioned { authorizationId: string; deviceId: string; payload: string; signature: string; keyVersion: number }
export interface DeviceCertificate extends Versioned { deviceId: string; ownerUserId: string; publicKey: string; keyVersion: number; activatedAt: string; expiresAt: string; signature: string }
export interface MerchantReceipt extends Versioned { transactionId: string; merchantProfileId: string; acceptedAt: string; requestHash: string; signature: string }
export interface ServerReceipt extends Versioned { transactionId: string; state: 'SETTLED' | 'REJECTED' | 'REQUIRES_REVIEW'; decidedAt: string; decisionOrder: number; signature: string }
export interface RevocationNotice extends Versioned { deviceId: string; keyVersion: number; revokedAt: string; reason: string; signature: string }
export interface OfflineCommand extends Versioned { commandId: string; expectedServerVersion: number; kind: string; payload: unknown }
export interface OfflineCommandResult extends Versioned { commandId: string; outcome: 'APPLIED' | 'REPLAYED' | 'CONFLICT' | 'REJECTED'; serverVersion: number }
export interface SyncBatch extends Versioned { batchId: string; deviceId: string; transactions: SignedEnvelope[]; commands: OfflineCommand[] }
export interface OfflineSerializer {
  readonly version: typeof OFFLINE_CONTRACT_VERSION;
  serialize(value: SignedEnvelope | DeviceCertificate | MerchantReceipt | ServerReceipt | RevocationNotice | SyncBatch): Uint8Array;
  deserialize<T extends Versioned>(bytes: Uint8Array): T;
}
export function assertOfflineVersion(value: Versioned): void {
  if (value.version !== OFFLINE_CONTRACT_VERSION) throw new Error('UNSUPPORTED_OFFLINE_CONTRACT_VERSION');
}
