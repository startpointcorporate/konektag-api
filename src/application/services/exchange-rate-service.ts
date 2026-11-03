import pool from '../../infrastructure/database/pool.ts';

export const SUPPORTED_CURRENCIES = ['XOF', 'XAF', 'EUR', 'USD', 'LBP', 'AOA', 'CDF', 'GNF'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

/** Devise de référence pour le stockage, ERPNext, calcul de solde */
export const BASE_CURRENCY = (process.env.ERP_CURRENCY || 'EUR').toUpperCase();

const XOF_RATES: Record<string, number> = {
  XOF: 1,
  XAF: 1,
  EUR: 656,
  USD: 605,
  LBP: 0.05,
  AOA: 0.65,
  CDF: 0.33,
};

/** Conversion synchrone avec taux fixes — pour le ledger et l'affichage */
export function convertStatic(amount: number, from: string, to: string): number {
  if (from === to) return Math.round(amount);
  if (from === BASE_CURRENCY && to === BASE_CURRENCY) return Math.round(amount);
  const fromXof = from === 'XOF' || from === 'XAF' ? 1 : (XOF_RATES[from] || 1);
  const toXof = to === 'XOF' || to === 'XAF' ? 1 : (XOF_RATES[to] || 1);
  const inXof = from === 'XOF' || from === 'XAF' ? amount : Math.round(amount * fromXof);
  return to === 'XOF' || to === 'XAF' ? Math.round(inXof) : Math.round(inXof / toXof);
}

export const exchangeRateService = {
  async getRateEvidence(from: string, to: string): Promise<{
    id: string; rate: string; inverse: boolean; source: string | null; valuedAt: string;
  } | null> {
    for (const [sourceCurrency, targetCurrency, inverse] of [[from, to, false], [to, from, true]] as const) {
      const { rows: [row] } = await pool.query<{
        id: string; rate: string; rate_source: string | null; valued_at: Date;
      }>(`SELECT id,rate::text AS rate,rate_source,COALESCE(published_at,valid_from) AS valued_at
          FROM konektag.exchange_rates WHERE from_currency=$1 AND to_currency=$2
          AND valid_from<=now() AND valid_to>now() ORDER BY valid_from DESC LIMIT 1`,
        [sourceCurrency, targetCurrency]);
      if (row) return { id: row.id, rate: row.rate, inverse, source: row.rate_source,
        valuedAt: new Date(row.valued_at).toISOString() };
    }
    return null;
  },
  /**
   * Get rate: 1 unit of `from` = X units of `to`
   * Supports direct lookup, inverse, and chain via XOF.
   */
  async getRate(from: string, to: string): Promise<number | null> {
    if (from === to) return 1;

    // Direct lookup
    const { rows } = await pool.query(
      `SELECT rate FROM konektag.exchange_rates
       WHERE from_currency = $1 AND to_currency = $2
         AND valid_from <= now() AND valid_to > now()
       ORDER BY valid_from DESC LIMIT 1`,
      [from, to],
    );
    if (rows.length > 0) return Number(rows[0].rate);

    // Inverse
    const { rows: inv } = await pool.query(
      `SELECT rate FROM konektag.exchange_rates
       WHERE from_currency = $1 AND to_currency = $2
         AND valid_from <= now() AND valid_to > now()
       ORDER BY valid_from DESC LIMIT 1`,
      [to, from],
    );
    if (inv.length > 0) return 1 / Number(inv[0].rate);

    // Chain via XOF
    const fromXof = XOF_RATES[from];
    const toXof = XOF_RATES[to];
    if (fromXof !== undefined && toXof !== undefined) {
      return fromXof / toXof;
    }

    return null;
  },

  async convert(amount: number, from: string, to: string): Promise<{ value: number; rate: number } | null> {
    const rate = await exchangeRateService.getRate(from, to);
    if (rate === null) return null;
    const value = Math.round(amount * rate * 1000000) / 1000000;
    return { value, rate };
  },

  isSupported(currency: string): boolean {
    return SUPPORTED_CURRENCIES.includes(currency as SupportedCurrency);
  },
};
