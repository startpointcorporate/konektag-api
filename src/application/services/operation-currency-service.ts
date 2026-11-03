import { currencyForMerchantCountry } from './country-currency-service.ts';
type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

export function currencyForCountry(country: unknown): string {
  return currencyForMerchantCountry(country);
}

export function requireCanonicalCurrency(country: unknown, requestedCurrency?: unknown): string {
  const currency = currencyForCountry(country);
  if (requestedCurrency !== undefined && requestedCurrency !== null
    && String(requestedCurrency).trim().toUpperCase() !== currency) {
    throw new Error('OPERATION_CURRENCY_MISMATCH');
  }
  return currency;
}

export async function resolveUserOperationCurrency(
  client: Queryable,
  userId: string,
  requestedCurrency?: unknown,
): Promise<{ country: string; currency: string }> {
  const { rows: [user] } = await client.query(
    `SELECT u.country FROM konektag.users u
     WHERE (u.id::text = $1 OR u.keycloak_id::text = $1) AND u.deleted_at IS NULL
     LIMIT 1`,
    [userId],
  );
  if (!user) throw new Error('OPERATION_USER_NOT_FOUND');
  const country = String(user.country || '').trim().toUpperCase();
  return { country, currency: requireCanonicalCurrency(country, requestedCurrency) };
}

export async function resolveMerchantOperationCurrency(
  client: Queryable,
  merchantProfileId: string,
  requestedCurrency?: unknown,
): Promise<{ country: string; currency: string }> {
  const { rows: [merchant] } = await client.query(
    `SELECT mp.country AS merchant_country
     FROM konektag.merchant_profiles mp
     WHERE mp.id = $1 AND mp.deleted_at IS NULL`,
    [merchantProfileId],
  );
  if (!merchant) throw new Error('MERCHANT_NOT_FOUND');
  const country = String(merchant.merchant_country || '').trim().toUpperCase();
  return { country, currency: requireCanonicalCurrency(country, requestedCurrency) };
}

export async function resolveLegalEntityCurrency(
  client: Queryable,
  legalEntityId: string,
  requestedCurrency?: unknown,
): Promise<{ country: string; currency: string }> {
  const { rows: [entity] } = await client.query(
    `SELECT country_code, base_currency FROM konektag.legal_entities
     WHERE id = $1 AND status = 'APPROVED' AND deleted_at IS NULL`,
    [legalEntityId],
  );
  if (!entity) throw new Error('LEGAL_ENTITY_NOT_APPROVED');
  const country = String(entity.country_code || '').trim().toUpperCase();
  const currency = requireCanonicalCurrency(country, requestedCurrency);
  if (String(entity.base_currency || '').trim().toUpperCase() !== currency) {
    throw new Error('LEGAL_ENTITY_CURRENCY_MISMATCH');
  }
  return { country, currency };
}
