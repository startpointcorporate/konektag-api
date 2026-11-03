import { describe, expect, it } from 'vitest';
import { marketplaceActivityPath, marketplaceMerchantPath, marketplaceSlug } from '../../src/application/shared/marketplace/slug.ts';

describe('marketplaceSlug', () => {
  it.each([
    ['Douala', 'douala'],
    ['Yaoundé', 'yaounde'],
    ['Saint-Étienne', 'saint-etienne'],
    ['Pointe-Noire', 'pointe-noire'],
    ['Brazzaville', 'brazzaville'],
    ['  Poto-Poto  ', 'poto-poto'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(marketplaceSlug(input)).toBe(expected);
  });

  it('treats null and undefined as empty', () => {
    expect(marketplaceSlug(null)).toBe('');
    expect(marketplaceSlug(undefined)).toBe('');
  });
});

describe('canonical Marketplace paths', () => {
  it('builds the N2 route', () => {
    expect(marketplaceMerchantPath('fr', 'Yaoundé', 'chez-marie')).toBe('/fr/marketplace/yaounde/chez-marie/');
  });

  it('builds the N3 route', () => {
    expect(marketplaceActivityPath('en', 'Saint-Étienne', 'Restaurant', 'chez-marie')).toBe('/en/marketplace/saint-etienne/Restaurant/chez-marie/');
  });
});
