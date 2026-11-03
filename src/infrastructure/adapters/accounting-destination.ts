import type { FinancialTransaction, AccountingResult, ErpnextVoucherType } from '../../domain/Accounting.ts';
import { erpnext } from './erpnext-adapter.ts';
import { exchangeRateService } from '../../application/services/exchange-rate-service.ts';
import pool from '../database/pool.ts';
import { minorDecimal, minorDigits } from '../../application/services/pay/money-unit.ts';

export interface AccountingDestination {
  post(transaction: FinancialTransaction, entries: AccountingEntryView[]): Promise<AccountingResult>;
}

export interface AccountingEntryView {
  accountCode: string;
  side: 'debit' | 'credit';
  amount: number;
  amountUnit?: 'MAJOR' | 'MINOR';
  currency: string;
  description: string | null;
}

async function resolveLegalEntityFromTransaction(txn: FinancialTransaction): Promise<{
  company: string;
  costCenter: string;
  legalEntityId: string;
  legalEntityCode: string;
  profileCode?: string;
  rail?: string;
}> {
  const raw = txn as any;
  const legalEntityId = raw.legal_entity_id as string | undefined;

  if (txn.amount_unit === 'MINOR') {
    const { rows } = await pool.query<{
      id: string; code: string; frappe_company: string | null; profile_code: string; rail: string;
    }>(`SELECT le.id, le.code, le.frappe_company, rp.profile_code, rp.rail
        FROM konektag.regulatory_profiles rp
        JOIN konektag.legal_entities le ON le.id=rp.legal_entity_id
        WHERE rp.id=$1 AND rp.corridor_id=$2 AND le.id=$3`,
      [raw.regulatory_profile_id, raw.corridor_id, legalEntityId]);
    if (rows.length !== 1 || !rows[0].frappe_company) {
      throw new Error(`Pro renewal ${txn.business_reference} has no Frappe company for its frozen corridor`);
    }
    return { company: rows[0].frappe_company, costCenter: `Main - ${rows[0].code}`,
      legalEntityId: rows[0].id, legalEntityCode: rows[0].code,
      profileCode: rows[0].profile_code, rail: rows[0].rail };
  }

  if (legalEntityId) {
    const { rows } = await pool.query(
      `SELECT code, frappe_company FROM konektag.legal_entities WHERE id = $1 AND deleted_at IS NULL`,
      [legalEntityId],
    );
    if (rows[0]?.frappe_company) {
      return {
        company: rows[0].frappe_company,
        // ERPNext names each entity's default cost center with its legal code.
        costCenter: `Main - ${rows[0].code}`,
        legalEntityId,
        legalEntityCode: rows[0].code,
      };
    }
  }

  throw new Error(
    `Aucune entite legale mappee pour la transaction ${txn.id}. ` +
    `Verifier que legal_entity_id est renseigne dans financial_transactions.`,
  );
}

const ACCOUNT_MAP: Record<string, string> = {
  '1000': '467100 - Portefeuille Utilisateurs Konektag - 2MBI',
  '1100': '467100 - Portefeuille Utilisateurs Konektag - 2MBI',
  '2000': '467200 - Dettes Commerçants Konektag - 2MBI',
  '3000': '7082 - Commissions et courtages - 2MBI',
  '3100': '7082 - Commissions et courtages - 2MBI',
  '4000': '467-Autres comptes débiteurs ou créditeurs (PASSIF) - 2MBI',
  '4100': '467-Autres comptes débiteurs ou créditeurs (PASSIF) - 2MBI',
  '5000': '467-Autres comptes débiteurs ou créditeurs (PASSIF) - 2MBI',
  '6000': '467-Autres comptes débiteurs ou créditeurs (PASSIF) - 2MBI',
  '7000': '467-Autres comptes débiteurs ou créditeurs (PASSIF) - 2MBI',
  '8000': '467-Autres comptes débiteurs ou créditeurs (PASSIF) - 2MBI',
  '9000': '467-Autres comptes débiteurs ou créditeurs (PASSIF) - 2MBI',
};

export class ErpNextAccountingDestination implements AccountingDestination {
  async post(
    transaction: FinancialTransaction,
    entries: AccountingEntryView[],
  ): Promise<AccountingResult> {
    const erpnextRef = transaction.business_reference;
    const txnCurrency = transaction.currency;
    const isProRenewal = transaction.amount_unit === 'MINOR' && transaction.transaction_type === 'fee_collection';

    if (!exchangeRateService.isSupported(txnCurrency)) {
      return {
        success: false,
        financialTransactionId: transaction.id,
        error: `Unsupported currency: ${txnCurrency}`,
      };
    }

    const { company, costCenter, legalEntityCode, profileCode, rail } = await resolveLegalEntityFromTransaction(transaction);
    let journalCostCenter = costCenter;
    let proAccounts: { debit_account: string; credit_account: string } | null = null;
    if (isProRenewal) {
      try { minorDigits(txnCurrency); }
      catch { return { success: false, financialTransactionId: transaction.id, error: `Unsupported Pro currency: ${txnCurrency}` }; }
      const frappeCompany = await erpnext.get('Company', company);
      if (frappeCompany.default_currency !== txnCurrency || !frappeCompany.abbr) {
        return { success: false, financialTransactionId: transaction.id,
          error: `Pro corridor currency ${txnCurrency} does not match Frappe company ${company}` };
      }
      if (!profileCode) return { success: false, financialTransactionId: transaction.id, error: 'Pro regulatory profile is missing' };
      const profile = await erpnext.get('Konektag Regulatory Profile', profileCode);
      if (profile.status !== 'Approved' || profile.legal_entity !== legalEntityCode
        || profile.corridor !== (transaction as any).corridor_id || profile.rail !== rail
        || !['stripe', 'pawapay'].includes(profile.runtime_provider)) {
        return { success: false, financialTransactionId: transaction.id, error: `Pro accounting profile ${profileCode} does not match the frozen corridor` };
      }
      const debit = profile.custom_pro_subscription_debit_account;
      const credit = profile.custom_pro_subscription_credit_account;
      const expectedCostCenter = profile.custom_pro_subscription_cost_center;
      if (!debit || !credit || !expectedCostCenter) {
        return { success: false, financialTransactionId: transaction.id, error: `Pro accounting configuration is incomplete for ${profileCode}` };
      }
      const centers = await erpnext.list('Cost Center',
        { company, name: expectedCostCenter, is_group: 0 }, ['name'], 2);
      if (centers.length !== 1) {
        return { success: false, financialTransactionId: transaction.id,
          error: `Pro cost center ${expectedCostCenter} is unavailable for ${company}` };
      }
      journalCostCenter = centers[0].name;
      for (const [name, root] of [[debit, 'Asset'], [credit, 'Income']] as const) {
        const account = await erpnext.get('Account', name);
        if (!account || account.company !== company || account.account_currency !== txnCurrency
          || account.root_type !== root || account.is_group || account.disabled) {
          return { success: false, financialTransactionId: transaction.id,
            error: `Pro account ${name} is unavailable for ${company} and ${txnCurrency}` };
        }
      }
      proAccounts = { debit_account: debit, credit_account: credit };
    }

    let buyerMerchantId: string | null = null;
    let subscriptionType: string | null = null;
    if (isProRenewal) {
      const { rows: [intent] } = await pool.query<{ merchant_profile_id: string; subscription_type: string }>(
        `SELECT merchant_profile_id, subscription_type
         FROM konektag.merchant_pro_renewal_intents
         WHERE payment_order_id=$1 AND status='APPLIED'`, [erpnextRef]);
      const recordedMerchantId = (transaction as any).merchant_profile_id;
      if (!intent || !recordedMerchantId || intent.merchant_profile_id !== recordedMerchantId) {
        return { success: false, financialTransactionId: transaction.id,
          error: `Pro renewal ${erpnextRef} has no matching buyer merchant` };
      }
      buyerMerchantId = intent.merchant_profile_id;
      subscriptionType = intent.subscription_type;
    }

    const existing = await this.findExistingVoucher(erpnextRef,
      isProRenewal ? `Konektag ${transaction.transaction_type} — ${erpnextRef}` : undefined);
    if (existing) {
      if (isProRenewal) {
        const voucher = await erpnext.get('Journal Entry', existing.voucherId);
        if (voucher.company !== company ||
            !String(voucher.user_remark ?? '').includes(`buyer_merchant_profile_id=${buyerMerchantId}`) ||
            !String(voucher.user_remark ?? '').includes(`corridor_id=${(transaction as any).corridor_id}`)) {
          return { success: false, financialTransactionId: transaction.id,
            error: `Existing Frappe voucher ${existing.voucherId} does not match Pro buyer and corridor` };
        }
        if (voucher.docstatus === 0) await erpnext.submit('Journal Entry', existing.voucherId);
        else if (voucher.docstatus !== 1) {
          return { success: false, financialTransactionId: transaction.id,
            error: `Existing Frappe voucher ${existing.voucherId} is not submitted` };
        }
      }
      return {
        success: true,
        financialTransactionId: transaction.id,
        erpnextVoucherType: existing.voucherType,
        erpnextVoucherId: existing.voucherId,
      };
    }

    // The Pro price was converted once when Checkout created the corridor order.
    // Its frozen amount stays in that currency through the ledger and Frappe.
    const rateResult = isProRenewal ? null : await exchangeRateService.convert(1, txnCurrency, 'EUR');
    if (!isProRenewal && !rateResult) {
      return {
        success: false,
        financialTransactionId: transaction.id,
        error: `No exchange rate from ${txnCurrency} to EUR`,
      };
    }
    const exchangeRate = isProRenewal ? 1 : rateResult!.rate;

    // Construire les lignes de la Journal Entry
    // Utiliser le guide d'ecriture par entite legale si disponible,
    // sinon fallback sur le ACCOUNT_MAP global
    const raw = transaction as any;
    const legalEntityId = raw.legal_entity_id as string | undefined;
    const eventType = isProRenewal ? 'subscription_sale' : transaction.transaction_type;
    let entryGuide: { debit_account: string; credit_account: string } | null = null;

    if (isProRenewal) {
      entryGuide = proAccounts;
    } else if (legalEntityId && eventType) {
      const { rows: [guide] } = await pool.query(
        `SELECT debit_account, credit_account FROM konektag.accounting_entry_guides
         WHERE legal_entity_id = $1 AND event_type = $2 AND is_active = true AND deleted_at IS NULL`,
        [legalEntityId, eventType],
      );
      if (guide) entryGuide = guide;
    }
    if (entries.some(e => e.amountUnit === 'MINOR') && !entryGuide) {
      return {
        success: false,
        financialTransactionId: transaction.id,
        error: `Pro renewal ${erpnextRef} has no Frappe accounting guide for ${legalEntityCode}`,
      };
    }

    const accounts = entries.map(e => {
      let accountName: string;
      if (entryGuide) {
        accountName = e.side === 'debit' ? entryGuide.debit_account : entryGuide.credit_account;
        if (!isProRenewal) accountName = `${accountName} - ${legalEntityCode}`;
      } else {
        accountName = ACCOUNT_MAP[e.accountCode];
      }
      if (!accountName) {
        throw new Error(`Unknown account for entity=${legalEntityId} event=${eventType} side=${e.side} code=${e.accountCode}`);
      }
      if (isProRenewal && (e.amountUnit !== 'MINOR' || e.currency !== txnCurrency)) {
        throw new Error(`Pro ledger entry unit or currency does not match ${txnCurrency}`);
      }
      const amountInCompanyCurrency = isProRenewal
        ? minorDecimal(e.amount, txnCurrency)
        : Math.round(e.amount * rateResult!.rate * 100) / 100;
      const entry: Record<string, unknown> = {
        account: accountName,
        cost_center: journalCostCenter,
        exchange_rate: 1,
      };
      if (e.side === 'debit') {
        entry.debit_in_account_currency = amountInCompanyCurrency;
      } else {
        entry.credit_in_account_currency = amountInCompanyCurrency;
      }
      return entry;
    });

    try {
      const doc = await erpnext.create('Journal Entry', {
        title: `Konektag ${transaction.transaction_type} — ${erpnextRef}`,
        posting_date: new Date().toISOString().slice(0, 10),
        company,
        cost_center: journalCostCenter,
        voucher_type: 'Journal Entry',
        multi_currency: 0,
        user_remark: `Konektag ${transaction.transaction_type} — ${erpnextRef} | ${txnCurrency}`
          + (isProRenewal ? '' : ` @ ${exchangeRate}`)
          + (isProRenewal ? ` | buyer_merchant_profile_id=${buyerMerchantId}`
            + ` | subscription_type=${subscriptionType}`
            + ` | legal_entity_id=${(transaction as any).legal_entity_id}`
            + ` | corridor_id=${(transaction as any).corridor_id}` : ''),
        accounts,
        konektag_reference: erpnextRef,
      });

      // Soumettre la Journal Entry (docstatus 0 → 1)
      const submitted = await erpnext.submit('Journal Entry', doc.name);

      return {
        success: true,
        financialTransactionId: transaction.id,
        erpnextVoucherType: 'Journal Entry',
        erpnextVoucherId: submitted.name || doc.name,
      };

    } catch (error) {
      return {
        success: false,
        financialTransactionId: transaction.id,
        error: (error as Error).message,
      };
    }
  }

  private async findExistingVoucher(reference: string, fallbackTitle?: string): Promise<{
    voucherType: ErpnextVoucherType;
    voucherId: string;
  } | null> {
    try {
      const results = await erpnext.list('Journal Entry', {
        konektag_reference: reference,
      }, ['name', 'title'], 1);
      if (results.length > 0) {
        return {
          voucherType: 'Journal Entry' as ErpnextVoucherType,
          voucherId: results[0].name,
        };
      }
    } catch {
      // Champ konektag_reference peut ne pas être créé immédiatement.
    }
    if (fallbackTitle) {
      const results = await erpnext.list('Journal Entry', { title: fallbackTitle }, ['name', 'title'], 1);
      if (results.length > 0) return { voucherType: 'Journal Entry', voucherId: results[0].name };
    }
    return null;
  }
}
