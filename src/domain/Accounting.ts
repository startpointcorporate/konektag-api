export type PartyType = 'individual' | 'merchant' | 'organization' | 'platform' | 'operator' | 'bank';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type FinancialAccountCode =
  | '1000' | '1100' | '1200' | '2000' | '2100'
  | '3000' | '3100'
  | '4000' | '4100' | '4200'
  | '5000'
  | '6000' | '7000' | '8000'
  | '9000';

export type EntrySide = 'debit' | 'credit';

export type FinancialTransactionStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export type AccountingStatus = 'pending' | 'processing' | 'posted' | 'failed' | 'reversed';

export type FinancialTransactionType =
  | 'api_payment'
  | 'qr_payment'
  | 'wallet_recharge'
  | 'acquisition'
  | 'k_send'
  | 'link_payment'
  | 'consumption'
  | 'clearing'
  | 'cashback'
  | 'activation_bonus'
  | 'commission'
  | 'fee_collection'
  | 'settlement'
  | 'refund'
  | 'fee'
  | 'reversal';

export type AccountingOutboxStatus = 'pending' | 'processing' | 'processed' | 'failed';

export type ErpnextVoucherType = 'Journal Entry' | 'Payment Entry' | 'Sales Invoice' | 'Purchase Invoice' | 'Credit Note';

export interface Party {
  id: string;
  party_type: PartyType;
  keycloak_id: string | null;
  legal_name: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FinancialAccount {
  id: string;
  account_code: FinancialAccountCode;
  account_name: string;
  account_type: AccountType;
  is_system: boolean;
  is_active: boolean;
  is_cash: boolean;
  parent_code: FinancialAccountCode | null;
  party_id: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface FinancialTransaction {
  id: string;
  transaction_type: FinancialTransactionType;
  business_reference: string;
  idempotency_key: string;
  currency: string;
  amount_unit?: 'MAJOR' | 'MINOR';
  status: FinancialTransactionStatus;
  accounting_status: AccountingStatus;
  erpnext_voucher_type: ErpnextVoucherType | null;
  erpnext_voucher_id: string | null;
  reversed_transaction_id: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  failed_at: string | null;
  accounting_posted_at: string | null;
}

export interface LedgerEntry {
  id: string;
  transaction_id: string | null;
  client_id: string | null;
  entry_type: EntrySide;
  entry_side: EntrySide;
  account_code: FinancialAccountCode | null;
  party_id: string | null;
  amount: number;
  currency: string;
  document_type: string;
  document_ref: string | null;
  description: string | null;
  is_reversal: boolean;
  reversed_entry_id: string | null;
  created_at: string;
  created_by: string | null;
}

export interface AccountingOutboxEvent {
  id: string;
  financial_transaction_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: AccountingOutboxStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface FinancialEntryInput {
  accountCode: FinancialAccountCode;
  partyId?: string;
  clientId?: string;
  side: EntrySide;
  amount: number;
  description?: string;
}

export type PostFinancialTransactionCommand = {
  idempotencyKey: string;
  transactionType: FinancialTransactionType;
  businessReference: string;
  currency: string;
  amountUnit?: 'MAJOR' | 'MINOR';
  description?: string;
  entries: FinancialEntryInput[];
  metadata?: Record<string, unknown>;
};

export type AccountingResult = {
  success: boolean;
  financialTransactionId: string;
  erpnextVoucherType?: ErpnextVoucherType;
  erpnextVoucherId?: string;
  error?: string;
};

export const FINANCIAL_ACCOUNT_LABELS: Record<FinancialAccountCode, string> = {
  '1000': 'Wallet Utilisateurs',
  '1100': 'Wallet Commerçants',
  '1200': 'Créances inter-sociétés',
  '2000': 'Dettes Commerçants',
  '2100': 'Dettes inter-sociétés',
  '3000': 'Frais Plateforme',
  '3100': 'Frais Opérateur',
  '4000': 'Cashback à Servir',
  '4100': 'Cashback Distribué',
  '4200': 'Bonus Activation Distribués',
  '5000': 'Commissions Ambassadeurs à Payer',
  '6000': 'Mobile Money Clearing',
  '7000': 'Banque Clearing',
  '8000': 'Suspense',
  '9000': 'Remboursements à Payer',
};
