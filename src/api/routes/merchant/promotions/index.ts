import { EntitlementDeniedError, entitlementResponse } from '../../../../application/services/entitlement-decision-service.ts';
import type { RouteHandler } from '../../../http';
import { promotionService } from '../../../../application/promotion-service.ts';
import { z } from 'zod';

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().max(30).optional(),
  discountType: z.enum(['percentage', 'fixed']),
  discountValue: z.number().positive(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  try {
    const promotions = await promotionService.listByMerchant(user.id);
    return new Response(JSON.stringify(promotions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof EntitlementDeniedError) return entitlementResponse(error.decision);
    if (error.message === 'MERCHANT_NOT_FOUND') {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    console.error('[merchant/promotions GET]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const promo = await promotionService.create(user.id, { ...parsed.data, startDate: parsed.data.startDate ?? new Date().toISOString() });
    return new Response(JSON.stringify(promo), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof EntitlementDeniedError) return entitlementResponse(error.decision);
    if (error.message === 'MERCHANT_NOT_FOUND') {
      return new Response(JSON.stringify({ error: 'MERCHANT_NOT_FOUND' }), { status: 404 });
    }
    console.error('[merchant/promotions POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
