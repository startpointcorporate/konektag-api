import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteHandler } from '../../src/api/http';

// Mock the entitlement service first
const mocks = vi.hoisted(() => ({
  getProduct: vi.fn()
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
    getProduct: mocks.getProduct
  }
}));

// Import after mocks are set up
import { GET } from '../../src/api/routes/merchant/products/[id].ts';

describe('GET /api/merchant/products/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns product for authenticated user', async () => {
    const mockProduct = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Test Product',
      description: 'Test Description',
      price: 10.99,
      category: 'Electronics'
    };
    
    mocks.getProduct.mockResolvedValue(mockProduct);
    
    const request = new Request('http://localhost/api/merchant/products/123e4567-e89b-12d3-a456-426614174000', {
      method: 'GET'
    });
    
    const locals = {
      user: { id: 'user-123' }
    };
    
    const params = { id: '123e4567-e89b-12d3-a456-426614174000' };
    
    const response = await GET({
      request,
      locals,
      params
    } as any);
    
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.product).toEqual(mockProduct);
  });

  it('returns 401 for unauthenticated user', async () => {
    const request = new Request('http://localhost/api/merchant/products/123e4567-e89b-12d3-a456-426614174000', {
      method: 'GET'
    });
    
    const locals = { user: null };
    
    const params = { id: '123e4567-e89b-12d3-a456-426614174000' };
    
    const response = await GET({
      request,
      locals,
      params
    } as any);
    
    expect(response.status).toBe(401);
  });

  it('returns 422 for invalid UUID', async () => {
    const request = new Request('http://localhost/api/merchant/products/not-a-uuid', {
      method: 'GET'
    });
    
    const locals = { user: { id: 'user-123' } };
    
    const params = { id: 'not-a-uuid' };
    
    const response = await GET({
      request,
      locals,
      params
    } as any);
    
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe('INVALID_PRODUCT_ID');
  });

  it('returns 404 for product not found', async () => {
    mocks.getProduct.mockRejectedValue(new Error('PRODUCT_NOT_FOUND'));
    
    const request = new Request('http://localhost/api/merchant/products/123e4567-e89b-12d3-a456-426614174000', {
      method: 'GET'
    });
    
    const locals = { user: { id: 'user-123' } };
    
    const params = { id: '123e4567-e89b-12d3-a456-426614174000' };
    
    const response = await GET({
      request,
      locals,
      params
    } as any);
    
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('returns 403 for product not owned', async () => {
    mocks.getProduct.mockRejectedValue(new Error('PRODUCT_NOT_OWNED'));
    
    const request = new Request('http://localhost/api/merchant/products/123e4567-e89b-12d3-a456-426614174000', {
      method: 'GET'
    });
    
    const locals = { user: { id: 'user-123' } };
    
    const params = { id: '123e4567-e89b-12d3-a456-426614174000' };
    
    const response = await GET({
      request,
      locals,
      params
    } as any);
    
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('PRODUCT_NOT_OWNED');
  });
});