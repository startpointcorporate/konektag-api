import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, type RouteHandler } from '../../src/api/http';
const m = vi.hoisted(() => ({ query: vi.fn(), getOrCreateCode: vi.fn(), getStats: vi.fn(), applyCode: vi.fn(), createReview: vi.fn(), getMerchantReviews: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: m.query } }));
vi.mock('../../src/application/services/referral-service.ts', () => ({ referralService: m }));
vi.mock('../../src/application/services/review-service.ts', () => ({ reviewService: m }));
import { POST as code } from '../../src/api/routes/referral/code';
import { GET as stats } from '../../src/api/routes/referral/stats';
import { POST as redeem } from '../../src/api/routes/referral/redeem';
import { POST as createReview } from '../../src/api/routes/reviews/create';
import { GET as reviews } from '../../src/api/routes/reviews/index';
import { GET as merchantReviews } from '../../src/api/routes/reviews/by-merchant';
function context(path: string, body?: unknown, signedIn = true) {
  const c = createContext(new Request(`https://api.invalid/api/${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  if (signedIn) c.locals.user = { id: 'session-user', keycloak_id: 'kc-owner' }; return c;
}
beforeEach(() => { vi.resetAllMocks(); m.query.mockResolvedValue({ rows: [{ id: 'db-owner' }] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); })); });
describe('referral', () => {
  it.each([['code', code], ['stats', stats], ['redeem', redeem]] as [string, RouteHandler][])('%s rejects anonymous callers before lookup or mutation', async (name, handler) => {
    expect((await handler(context(`referral/${name}`, {}, false))).status).toBe(401);
    expect(m.query).not.toHaveBeenCalled(); expect(m.applyCode).not.toHaveBeenCalled(); expect(m.getOrCreateCode).not.toHaveBeenCalled(); expect(m.getStats).not.toHaveBeenCalled();
  });
  it('creates or retrieves a code only for the resolved authenticated user', async () => {
    m.getOrCreateCode.mockResolvedValue('REF-TEST'); expect(await (await code(context('referral/code'))).json()).toEqual({ code: 'REF-TEST' });
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining('keycloak_id = $1'), ['kc-owner']); expect(m.getOrCreateCode).toHaveBeenCalledWith('db-owner');
  });
  it('returns referral stats only for the resolved user', async () => {
    m.getStats.mockResolvedValue({ referred: 3, earned: 20 }); expect(await (await stats(context('referral/stats'))).json()).toEqual({ referred: 3, earned: 20 });
    expect(m.getStats).toHaveBeenCalledWith('db-owner');
  });
  it('applies a referral to the authenticated user, ignoring a forged user id', async () => {
    expect(await (await redeem(context('referral/redeem', { code: 'REF-TEST', userId: 'victim' }))).json()).toEqual({ success: true });
    expect(m.applyCode).toHaveBeenCalledWith('REF-TEST', 'db-owner');
  });
  it('refuses an empty code without mutation', async () => {
    const response = await redeem(context('referral/redeem', {})); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'Code requis' }); expect(m.applyCode).not.toHaveBeenCalled();
  });
  it.each([['INVALID_CODE', 404], ['SELF_REFERRAL', 400], ['ALREADY_REDEEMED', 409]] as const)('maps %s without inventing success', async (error, status) => {
    m.applyCode.mockRejectedValue(new Error(error)); const response = await redeem(context('referral/redeem', { code: 'REF-TEST' }));
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error });
  });
});
describe('reviews', () => {
  it('requires an authenticated author before creating a review', async () => {
    const response = await createReview(context('reviews/create', { merchantSlug: 'shop', rating: 5 }, false));
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' }); expect(m.createReview).not.toHaveBeenCalled();
  });
  it.each([0, 6, 'invalid'])('refuses rating %s without writing a review', async rating => {
    const response = await createReview(context('reviews/create', { merchantSlug: 'shop', rating }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: 'BAD_REQUEST' }); expect(m.createReview).not.toHaveBeenCalled();
  });
  it('binds the review to the authenticated author and returns the created review', async () => {
    m.createReview.mockResolvedValue({ id: 'review-1', rating: 4 });
    const response = await createReview(context('reviews/create', { merchantSlug: 'shop', rating: '4', comment: 'Useful', userId: 'victim' }));
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ review: { id: 'review-1', rating: 4 } });
    expect(m.createReview).toHaveBeenCalledWith('session-user', 'shop', 4, 'Useful');
  });
  it('reports a rejected review without pretending it was created', async () => {
    m.createReview.mockRejectedValue(new Error('ALREADY_REVIEWED')); const response = await createReview(context('reviews/create', { merchantSlug: 'shop', rating: 4 }));
    expect(response.status).toBe(422); expect(await response.json()).toEqual({ error: 'REVIEW_ERROR', message: 'ALREADY_REVIEWED' });
  });
  it('returns the historical anonymous empty envelope without reading data', async () => {
    expect(await (await reviews(context('reviews', undefined, false))).json()).toEqual({ data: [], total: 0 }); expect(m.query).not.toHaveBeenCalled();
  });
  it('scopes review history to the resolved owner', async () => {
    m.query.mockResolvedValueOnce({ rows: [{ id: 'db-owner' }] }).mockResolvedValueOnce({ rows: [{ id: 'review-1' }] });
    expect(await (await reviews(context('reviews?limit=2'))).json()).toEqual({ data: [{ id: 'review-1' }], total: 1 });
    expect(m.query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE r.user_id = $1'), ['db-owner', 2]);
  });
  it('bounds public pagination and returns the merchant review aggregate', async () => {
    const result = { reviews: [{ rating: 5 }], total: 1, averageRating: 5 }; m.getMerchantReviews.mockResolvedValue(result);
    expect(await (await merchantReviews(context('reviews/by-merchant?slug=shop&limit=500&offset=-2'))).json()).toEqual(result);
    expect(m.getMerchantReviews).toHaveBeenCalledWith('shop', 100, 0);
  });
  it('reports unavailable merchant reviews explicitly', async () => {
    m.getMerchantReviews.mockRejectedValue(new Error('private database error')); const response = await merchantReviews(context('reviews/by-merchant?slug=shop'));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'REVIEWS_UNAVAILABLE' });
  });
});
