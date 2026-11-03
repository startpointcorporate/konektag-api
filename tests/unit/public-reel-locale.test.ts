import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/application/core-transaction-service.ts', () => ({ requireCoreMerchantActor: vi.fn(), resolveLines: vi.fn() }));
vi.mock('../../src/application/promotion-service.ts', () => ({ listActivePromotions: vi.fn() }));
import { listReels } from '../../src/application/public-catalog-service.ts';

const merchant = '11111111-1111-4111-8111-111111111111';
const product = '22222222-2222-4222-8222-222222222222';
const row = { merchant_profile_id: merchant, product_id: product, city: 'Pointe-Noire', activity_code: 'Commerce', slug: 'ma-boutique', article: 'Texte du commerçant conservé', media: [{ id: 'media', url: '/photo.png' }] };
beforeEach(() => mocks.query.mockReset());
describe('localized public Reel destinations', () => {
  it.each(['fr', 'en', 'ar'])('keeps %s in catalogue and activity links without translating business data', async locale => {
    mocks.query.mockResolvedValue({ rows: [{ ...row, destination: 'product' }, { ...row, destination: 'profile' }] });
    const result = await listReels({ city: 'Pointe-Noire', category: 'Commerce', locale });
    expect(result.map(reel => reel.path)).toEqual([`/${locale}/catalog/${merchant}/${product}/`, `/${locale}/marketplace/pointe-noire/Commerce/ma-boutique/`]);
    expect(result[0].article).toBe(row.article);
    expect(result[0].media).toEqual(row.media);
    expect(mocks.query.mock.calls[0][1]).toEqual(['Pointe-Noire', 'Commerce', null, false]);
  });
});
