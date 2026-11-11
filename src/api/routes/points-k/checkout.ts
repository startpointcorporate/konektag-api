import { z } from 'zod';
import type { RouteHandler } from '../../http.ts';
import { createPointsKCheckout, PointsKCheckoutError, readPointsKCheckout } from '../../../application/services/pay/points-k-checkout-service.ts';

const refs = z.object({ country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/), customer: z.string().min(1).max(140), quotation: z.string().min(1).max(140) }).strict();
const create = refs.extend({ modeOfPayment: z.string().min(1).max(140) }).strict();
const status = (code: string) => code.includes('NOT_OWNED') ? 404 : code.includes('NOT_ALLOWED') || code.includes('MISMATCH') ? 409 : 502;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const GET: RouteHandler = async ({ url, locals }) => {
  if (!locals.user) return response({ error: 'Unauthorized' }, 401);
  const parsed = refs.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return response({ error: 'INVALID_REQUEST' }, 400);
  try { return response(await readPointsKCheckout({ ...parsed.data, keycloakId: locals.user.keycloak_id, userId: locals.user.id })); }
  catch (error) { return error instanceof PointsKCheckoutError ? response({ error: error.code }, status(error.code)) : response({ error: 'POINTS_K_CHECKOUT_FAILED' }, 500); }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return response({ error: 'Unauthorized' }, 401);
  const parsed = create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return response({ error: 'INVALID_REQUEST' }, 400);
  try { return response(await createPointsKCheckout({ ...parsed.data, keycloakId: locals.user.keycloak_id, userId: locals.user.id }), 201); }
  catch (error) { return error instanceof PointsKCheckoutError ? response({ error: error.code }, status(error.code)) : response({ error: 'POINTS_K_CHECKOUT_FAILED' }, 500); }
};
