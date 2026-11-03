import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = { query: vi.fn(), release: vi.fn() };
const mockPool = { query: vi.fn(), connect: vi.fn(async () => mockClient) };
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: mockPool }));
vi.mock('../../src/infrastructure/correlation-id.ts', () => ({ getCorrelationId: () => 'corr-test' }));

let reviewService: typeof import('../../src/application/services/review-service.ts').reviewService;

beforeEach(async () => {
  vi.resetAllMocks();
  ({ reviewService } = await import('../../src/application/services/review-service.ts'));
});

describe('reviewService.createReview', () => {
  it('crée un avis et résout le nom via users.username (pas de colonne profile)', async () => {
    // 1. merchant par slug
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'mp-1', user_id: 'owner-1', business_name: 'Chez Amina' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // no merchant membership
    // 2. pas d'avis existant
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // Transaction client : BEGIN, INSERT, UPDATE rating, outbox, audit, loyalty SELECT, loyalty UPDATE, COMMIT
    mockClient.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // parent publication lock
      .mockResolvedValueOnce({ rows: [{ id: 'rev-1', user_id: 'u-1', merchant_id: 'mp-1', rating: 5, comment: 'Top', created_at: '', updated_at: '', version: 1 }] }) // INSERT
      .mockResolvedValue({ rows: [] }); // le reste

    // Nom d'affichage (pool.query après COMMIT)
    mockPool.query.mockResolvedValueOnce({ rows: [{ display_name: 'amina_demo' }] });

    const review = await reviewService.createReview('u-1', 'chez-amina', 5, 'Top');

    const nameQuery = mockPool.query.mock.calls.at(-1)!;
    expect(nameQuery[0]).toContain('username');
    expect(nameQuery[0]).not.toContain('profile->>');
    expect(review.userName).toBe('amina_demo');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('rejette un second avis du même utilisateur', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'mp-1', user_id: 'owner-1', business_name: 'Chez Amina' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // no merchant membership
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'rev-existing' }] });

    await expect(reviewService.createReview('u-1', 'chez-amina', 4)).rejects.toThrow('déjà donné votre avis');
  });
});

describe('reviewService.getMerchantReviews', () => {
  it('liste les avis en joignant users.username (pas de colonne profile)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'mp-1' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ total: '1', average_rating: '4.0' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'rev-1', rating: 4, user_name: 'amina_demo' }] });

    const result = await reviewService.getMerchantReviews('chez-amina');

    const listQuery = mockPool.query.mock.calls.at(-1)!;
    expect(listQuery[0]).not.toContain('profile->>');
    expect(listQuery[0]).toContain('u.username');
    expect(result.total).toBe(1);
    expect(result.averageRating).toBe(4);
    expect(result.reviews[0].userName).toBe('amina_demo');
  });
});
