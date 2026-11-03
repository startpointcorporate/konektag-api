import pool from '../../../infrastructure/database/pool.ts';
import { paymentContextResolver } from './payment-context-resolver.ts';

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export type PaymentCountryResolution = {
  detectedCountry: string;
  paymentCountry: string;
};

export class PaymentCountryResolutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PaymentCountryResolutionError';
  }
}

function normalizeCountry(country: string): string {
  const normalized = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) throw new PaymentCountryResolutionError('PAYMENT_COUNTRY_INVALID');
  return normalized;
}

export class PaymentCountryResolver {
  constructor(private readonly database: Queryable = pool) {}

  async resolve(detectedCountryInput: string): Promise<PaymentCountryResolution> {
    const detectedCountry = normalizeCountry(detectedCountryInput);
    const { rows } = await this.database.query(
      `SELECT payment_country
       FROM konektag.payment_country_mappings
       WHERE detected_country = $1 AND status = 'ACTIVE'
         AND valid_from <= CURRENT_DATE
         AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`,
      [detectedCountry],
    );
    if (rows.length === 0) {
      throw new PaymentCountryResolutionError('PAYMENT_COUNTRY_MAPPING_NOT_FOUND');
    }
    if (rows.length > 1) throw new PaymentCountryResolutionError('PAYMENT_COUNTRY_MAPPING_AMBIGUOUS');
    return { detectedCountry, paymentCountry: rows[0].payment_country };
  }
}

export const paymentCountryResolver = new PaymentCountryResolver();
