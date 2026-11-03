type Database = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export type MerchantCommissionRail = 'qr' | 'payment_link';

export type MerchantCommissionQuote = {
  ruleId: string;
  paymentCountry: string;
  rail: MerchantCommissionRail;
  percentageBps: number;
  amountExactMinor: string;
};

export async function resolveMerchantCommission(
  db: Database,
  input: { paymentCountry: string; rail: MerchantCommissionRail; transactionAmountMinor: number; at?: Date },
): Promise<MerchantCommissionQuote> {
  if (!Number.isSafeInteger(input.transactionAmountMinor) || input.transactionAmountMinor <= 0)
    throw new Error('MERCHANT_COMMISSION_AMOUNT_INVALID');
  const country=input.paymentCountry.trim().toUpperCase();
  const at=input.at ?? new Date();
  const {rows:[rule]}=await db.query(
    `SELECT id,percentage_bps
       FROM konektag.merchant_payment_commission_rules
      WHERE payment_country=$1 AND rail=$2 AND status='APPROVED'
        AND valid_from<=$3 AND (valid_until IS NULL OR valid_until>$3)
      ORDER BY valid_from DESC,id DESC LIMIT 1`,
    [country,input.rail,at],
  );
  if(!rule) throw new Error('MERCHANT_COMMISSION_RULE_REQUIRED');
  const bps=Number(rule.percentage_bps);
  if(!Number.isSafeInteger(bps) || bps<0 || bps>10000) throw new Error('MERCHANT_COMMISSION_RULE_INVALID');
  // Keep the exact fraction until settlement; rounding happens once per settlement/currency.
  const amount=(BigInt(input.transactionAmountMinor)*BigInt(bps));
  const whole=amount/10000n, fraction=(amount%10000n).toString().padStart(4,'0').replace(/0+$/,'');
  return {ruleId:String(rule.id),paymentCountry:country,rail:input.rail,percentageBps:bps,
    amountExactMinor:fraction ? `${whole}.${fraction}` : String(whole)};
}
