/**
 * Merchant location invariant: a merchant establishment always has a country
 * and a city. Marketplace URLs, publication and public QR codes depend on it.
 *
 * Isomorphic (no server dependencies).
 */
import { MerchantLocationRequiredError, type MerchantLocationField } from './MerchantErrors.ts';

export interface MerchantLocation {
  country: string;
  city: string;
}

export interface MerchantLocationInput {
  country?: string | null;
  city?: string | null;
}

function locationPart(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function missingMerchantLocationFields(input: MerchantLocationInput): MerchantLocationField[] {
  const missing: MerchantLocationField[] = [];
  if (!locationPart(input.country)) missing.push('country');
  if (!locationPart(input.city)) missing.push('city');
  return missing;
}

export function hasMerchantLocation(input: MerchantLocationInput): boolean {
  return missingMerchantLocationFields(input).length === 0;
}

/** Returns the trimmed location, or throws when country or city is missing/blank. */
export function requireMerchantLocation(input: MerchantLocationInput): MerchantLocation {
  const missing = missingMerchantLocationFields(input);
  if (missing.length > 0) throw new MerchantLocationRequiredError(missing);
  return { country: locationPart(input.country)!, city: locationPart(input.city)! };
}
