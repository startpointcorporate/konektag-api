export type LegalEntityStatus =
  | 'NOT_CONFIGURED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SUSPENDED'
  | 'REVOKED';

export type CounterpartyEntityType =
  | 'psp'
  | 'bank'
  | 'mobile_money'
  | 'crypto'
  | 'emisor'
  | 'other';

export type CounterpartyStatus =
  | 'NOT_CONFIGURED'
  | 'PENDING_ONBOARDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'TERMINATED';

export type RegulatedActorType =
  | 'psp'
  | 'eme'
  | 'bank'
  | 'mobile_money_operator'
  | 'crypto_exchange'
  | 'internal';

export type RegulatedActorStatus =
  | 'NOT_CONFIGURED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'SUSPENDED'
  | 'REVOKED';

export type AuthorizedOperation =
  | 'acquisition'
  | 'k_send'
  | 'qr_payment'
  | 'link_payment'
  | 'consumption'
  | 'settlement'
  | 'clearing'
  | 'refund'
  | 'reversal';

export type FundHolder =
  | 'konektag_user'
  | 'konektag_france'
  | 'konektag_congo'
  | 'regulated_actor';

export type Rail =
  | 'stripe'
  | 'mtn_money'
  | 'orange_money'
  | 'airtel_money'
  | 'mobile_money'
  | 'bank_transfer'
  | 'crypto'
  | 'internal'
  | 'manual';

export type ExecutionMode =
  | 'provider_confirmation'
  | 'manual_double_approval'
  | 'reconciliation';

export type KycLevel =
  | 'none'
  | 'basic'
  | 'standard'
  | 'enhanced';

export type RegulatoryProfileStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'EXPIRED'
  | 'SUSPENDED'
  | 'REVOKED';

export type B2BProfileStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'EXPIRED'
  | 'SUSPENDED';

export type ComplianceCaseType =
  | 'sanction_hit'
  | 'pep_match'
  | 'ubo_alert'
  | 'country_risk'
  | 'kyc_exception'
  | 'kyb_exception'
  | 'fraud_alert'
  | 'other';

export type ComplianceCaseSeverity = 'low' | 'medium' | 'high' | 'critical';

export type ComplianceCaseStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'ESCALATED'
  | 'RESOLVED_APPROVED'
  | 'RESOLVED_BLOCKED'
  | 'CLOSED';

export type KLotStatus =
  | 'CREATED'
  | 'VALUATED'
  | 'AVAILABLE'
  | 'PARTIALLY_CONSUMED'
  | 'EXHAUSTED'
  | 'FROZEN';

export type FxRiskHolder =
  | 'konektag_user'
  | 'konektag_france'
  | 'konektag_congo';

export type FxSource =
  | 'manual'
  | 'central_bank'
  | 'provider_quote';

export type SettlementFrequency =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'on_demand';

export type MerchantSaleStatus =
  | 'CREATED'
  | 'SETTLED'
  | 'PARTIALLY_SETTLED'
  | 'CANCELLED';

export type IntercompanyPositionStatus =
  | 'OPEN'
  | 'INCLUDED_IN_BATCH'
  | 'SETTLED'
  | 'CANCELLED';

export type IntercompanyDirection = 'A_TO_B' | 'B_TO_A';

export type EligibilityDecision =
  | 'ALLOWED'
  | 'BLOCKED_KYC'
  | 'BLOCKED_PROFILE'
  | 'BLOCKED_COMPLIANCE'
  | 'BLOCKED_RAIL'
  | 'BLOCKED_LIMIT'
  | 'BLOCKED_NOT_CONFIGURED';

export interface LegalEntity {
  id: string;
  code: string;
  legalName: string;
  countryCode: string;
  baseCurrency: string;
  frappeCompany: string | null;
  regulatoryIdentifier: string | null;
  taxId: string | null;
  status: LegalEntityStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CounterpartyEntity {
  id: string;
  code: string;
  legalName: string;
  entityType: CounterpartyEntityType;
  countryCode: string | null;
  licenseIdentifier: string | null;
  contractRef: string | null;
  contractSignedAt: string | null;
  status: CounterpartyStatus;
  version: number;
}

export interface RegulatedActor {
  id: string;
  actorCode: string;
  actorName: string;
  actorType: RegulatedActorType;
  counterpartyId: string | null;
  jurisdiction: string | null;
  licenseRef: string | null;
  licenseValidFrom: string | null;
  licenseValidUntil: string | null;
  status: RegulatedActorStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  version: number;
}

export interface RegulatoryProfile {
  id: string;
  profileCode: string;
  profileName: string;
  legalEntityId: string | null;
  legalEntity?: LegalEntity;
  countryOfOrigin: string;
  countryOfDestination: string;
  corridorId: string;
  authorizedOperation: AuthorizedOperation;
  fundHolder: FundHolder;
  regulatedActorId: string | null;
  regulatedActor?: RegulatedActor;
  rail: Rail;
  executionMode: ExecutionMode;
  minKycLevel: KycLevel;
  maxAmountPerTx: number | null;
  maxAmountDaily: number | null;
  maxAmountMonthly: number | null;
  maxKSendDepth: number;
  nettingAllowed: boolean;
  evidenceRequired: string[];
  status: RegulatoryProfileStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  validFrom: string;
  validUntil: string | null;
  version: number;
}

export interface B2BSettlementProfile {
  id: string;
  profileCode: string;
  legalEntityAId: string;
  legalEntityBId: string;
  nettingAllowed: boolean;
  settlementCurrency: string;
  fxSource: FxSource;
  fxSpreadBps: number;
  minSettlementAmount: number | null;
  settlementFrequency: SettlementFrequency;
  requiredApprovals: string[];
  status: B2BProfileStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  validFrom: string;
  validUntil: string | null;
  version: number;
}

export interface ComplianceCase {
  id: string;
  caseRef: string;
  caseType: ComplianceCaseType;
  severity: ComplianceCaseSeverity;
  subjectPartyId: string | null;
  subjectUserId: string | null;
  legalEntityId: string | null;
  triggeredBy: string;
  triggeredAt: string;
  status: ComplianceCaseStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  finalDecision: string | null;
  version: number;
  evidence: unknown[];
  notes: string | null;
}

export interface KLot {
  id: string;
  klotRef: string;
  originEntityId: string;
  originCountry: string;
  rail: Rail;
  railRef: string | null;
  issuer: string | null;
  quantityK: number;
  economicCurrency: string;
  economicValue: number;
  regulatoryProfileId: string | null;
  restrictions: Record<string, unknown>;
  status: KLotStatus;
  version: number;
}

export interface ValuationRecord {
  id: string;
  klotId: string;
  sourceCurrency: string;
  targetCurrency: string;
  rate: number;
  spreadBps: number;
  rateSource: string;
  rateTimestamp: string;
  fxRiskHolder: FxRiskHolder;
}

export interface MerchantSale {
  id: string;
  saleRef: string;
  merchantProfileId: string;
  legalEntityId: string;
  transactionId: string | null;
  klotId: string | null;
  grossAmount: number;
  netAmount: number;
  taxAmount: number;
  commissionAmount: number;
  currency: string;
  status: MerchantSaleStatus;
  settlementDueDate: string | null;
}

export interface IntercompanyPosition {
  id: string;
  positionRef: string;
  legalEntityAId: string;
  legalEntityBId: string;
  b2bProfileId: string | null;
  sourceSaleId: string | null;
  sourceKlotId: string | null;
  amount: number;
  currency: string;
  direction: IntercompanyDirection;
  valueDate: string;
  status: IntercompanyPositionStatus;
  clearingBatchId: string | null;
  version: number;
}

export interface EligibilityContext {
  operation: AuthorizedOperation;
  userId: string;
  keycloakId: string;
  countryOfOrigin: string;
  countryOfDestination: string;
  amount: number;
  currency: string;
  klotId: string | null;
  rail: Rail;
  recipientUserId?: string;
  merchantProfileId?: string;
}

export interface EligibilityResult {
  decision: EligibilityDecision;
  reason: string;
  profile: RegulatoryProfile | null;
  legalEntity: LegalEntity | null;
  regulatedActor: RegulatedActor | null;
  missingRequirements: string[];
}

export interface UserRegulatoryOverride {
  id: string;
  userId: string;
  operation: AuthorizedOperation;
  corridorId: string;
  maxAmountPerTx: number | null;
  maxAmountDaily: number | null;
  maxAmountMonthly: number | null;
  isActive: boolean;
  setBy: string | null;
  setAt: string;
  reason: string | null;
  validUntil: string | null;
  version: number;
}
