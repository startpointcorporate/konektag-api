import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteHandler } from '../../src/api/http';

// Mock the entitlement service first
const mocks = vi.hoisted(() => ({
  listProducts: vi.fn()
}));

vi.mock('../../src/application/services/entitlement-decision-service.ts', () => ({
  EntitlementDeniedError: class extends Error {
    constructor(readonly decision: unknown) {
      super('ENTITLEMENT_DENIED');
    }
  },
  entitlementResponse: (decision: any) => new Response(JSON.stringify({ error: 'ENTITLEMENT_DENIED' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
}));

vi.mock('../../src/application/merchant-service.ts', () => ({
  merchantService: {
    listProducts: mocks.listProducts
  }
}));

// Import after mocks are set up
import { GET } from '../../src/api/routes/merchant/products.ts';

describe('GET /api/merchant/products', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns products for authenticated user', async () => {
    const mockProducts = [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Test Product 1',
        description: 'Test Description 1',
        price: 10.99,
        category: 'Electronics'
      },
      {
        id: '123e4567-e89b-12d3-a456-426614174001',
        name: 'Test Product 2',
        description: 'Test Description 2',
        price: 20.99,
        category: 'Clothing'
      }
    ];
    
    mocks.listProducts.mockResolvedValue(mockProducts);
    
    const request = new Request('http://localhost/api/merchant/products', {
      method: 'GET'
    });
    
    const locals = {
      user: { id: 'user-123' }
    };
    
    const response = await GET({
      request,
      locals
    } as any);
    
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.products).toEqual(mockProducts);
  });

  it('returns 401 for unauthenticated user', async () => {
    const request = new Request('http://localhost/api/merchant/products', {
      method: 'GET'
    });
    
    const locals = { user: null };
    
    const response = await GET({
      request,
      locals
    } as any);
    
    expect(response.status).toBe(401);
  });

  it('propagates authorization errors correctly', async () => {
    mocks.listProducts.mockRejectedValue(new Error('MERCHANT_ACCESS_DENIED'));
    
    const request = new Request('http://localhost/api/merchant/products', {
      method: 'GET'
    });
    
    const locals = { user: { id: 'user-123' } };
    
    const response = await GET({
      request,
      locals
    } as any);
    
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('MERCHANT_ACCESS_DENIED');
  });
});