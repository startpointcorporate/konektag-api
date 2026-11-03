// This file defines pricing for the Pro subscription periods.
// It does not depend on any external libraries.

/**
 * Pro subscription period.
 */
export type ProPeriod = 'MONTHLY' | 'ANNUAL';

/**
 * Prices in minor units (cents) for the Euro currency.
 * These are constant values and should not be mutated.
 */
export const PRO_PRICING_EUR = {
  MONTHLY: 8900,
  ANNUAL: 101460,
} as const;

/**
 * Return the {@link proPrice} for a given {@link ProPeriod}.
 *
 * @param period - The period for the price lookup.
 * @returns An object containing the amount in minor units and the ISO 4217
 *          currency code for Euro.
 */
export function proPrice(period: ProPeriod): { amountMinor: number; currency: 'EUR' } {
  const amountMinor = PRO_PRICING_EUR[period];
  return { amountMinor, currency: 'EUR' };
}

/**
 * Compute a future date by adding a {@link ProPeriod} to the given start date.
 * The calculation is based on UTC, preserves the original start date, and
 * clamps the day of month to the last day of the target month if necessary.
 *
 * @param start - The original start date. This date will not be mutated.
 * @param period - The period to add: MONTHLY or ANNUAL.
 * @returns A new {@link Date} instance representing the calculated end date.
 */
export function addProPeriod(start: Date, period: ProPeriod): Date {
  if (!Number.isFinite(start.getTime()) || !['MONTHLY', 'ANNUAL'].includes(period)) throw new Error('INVALID_SUBSCRIPTION_PERIOD');
  // Work with UTC to avoid time‑zone issues.
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth(); // 0‑based
  const day = start.getUTCDate();

  if (period === 'MONTHLY') {
    // Target month is month + 1
    const targetMonth = month + 1;
    // Determine last day of the target month.
    const lastDayInTarget = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
    const newDay = Math.min(day, lastDayInTarget);
    return new Date(Date.UTC(year, targetMonth, newDay));
  }

  // ANNUAL
  const targetYear = year + 1;
  const targetMonth = month; // stay in same month
  const lastDayInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const newDay = Math.min(day, lastDayInTarget);
  return new Date(Date.UTC(targetYear, targetMonth, newDay));
}

export function renewalOpensAt(end: Date, period: ProPeriod): Date {
  if (!Number.isFinite(end.getTime())) throw new Error('INVALID_SUBSCRIPTION_DATE');
  if (period === 'MONTHLY') return new Date(end.getTime() - 5 * 86400000);
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() - 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(end.getUTCDate(), lastDay)));
}

// End of file
