import type { RechargeStatus, ProviderStatusDetail, LedgerStatus, PaymentMethodType } from '../../../../domain/RechargeProjection.ts';

export interface RechargeSummaryDTO {
  id: string;
  rechargeName: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  requestedAmount: number;
  requestedCurrency: string;
  creditedAmount: number | null;
  creditedCurrency: string | null;
  paymentMethod: PaymentMethodType;
  paymentProvider: string | null;
  paymentProviderName: string | null;
  rechargeStatus: RechargeStatus;
  providerStatusDetail: ProviderStatusDetail | null;
  ledgerStatus: LedgerStatus;
  providerReference: string | null;
  internalReference: string | null;
  country: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  reversedAt: string | null;
  anomaly: string | null;
  hasAnomaly: boolean;
}

export interface RechargeDetailDTO extends RechargeSummaryDTO {
  providerMessage: string | null;
  stripePaymentIntent: string | null;
  mobileMoneyOperator: string | null;
  mobileMoneyPhone: string | null;
  cryptoNetwork: string | null;
  cryptoAddress: string | null;
  user: {
    id: string;
    keycloakId: string;
    username: string;
    locale: string;
    country: string | null;
    state: string;
    role: string;
    bannedAt: string | null;
    createdAt: string;
  } | null;
  walletBalance: number | null;
  ledgerEntries: Array<{
    id: string;
    entrySide: string;
    amount: number;
    currency: string;
    description: string | null;
    isReversal: boolean;
    reversedEntryId: string | null;
    createdAt: string;
  }>;
  events: Array<{
    id: string;
    fromStatus: string | null;
    toStatus: string;
    changedBy: string | null;
    reason: string | null;
    createdAt: string;
  }>;
  adminActions: Array<{
    id: string;
    actionType: string;
    reason: string;
    createdAt: string;
  }>;
}

export interface PaginatedResultDTO<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}
