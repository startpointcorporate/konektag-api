import { EntitlementDeniedError, entitlementResponse } from '../../../../application/services/entitlement-decision-service.ts';
import type { RouteHandler } from '../../../http';
import { promotionService } from '../../../../application/promotion-service.ts';
import { z } from 'zod';

const UpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(30).optional(),
  discountType: z.enum(['percentage', 'fixed']).optional(),
  discountValue: z.number().positive().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional().nullable(),
});

export const PUT: RouteHandler = async ({ request, locals, params }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const promo = await promotionService.update(user.id, params.id!, { ...parsed.data, endDate: parsed.data.endDate ?? undefined });
    return new Response(JSON.stringify(promo), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof EntitlementDeniedError) return entitlementResponse(error.decision);
    if (error.message === 'NOT_FOUND') {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }
    console.error('[merchant/promotions PUT]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const POST: RouteHandler = async ({ request, locals, params }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  let body: any = {};
  try { body = await request.json(); } catch {}
  if (body.action === 'toggle') {
    try {
      const promo = await promotionService.toggleActive(user.id, params.id!);
      return new Response(JSON.stringify(promo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error: any) {
    if (error instanceof EntitlementDeniedError) return entitlementResponse(error.decision);
      if (error.message === 'NOT_FOUND') {
        return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
      }
      console.error('[merchant/promotions POST toggle]', error);
      return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
    }
  }
  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
};

export const DELETE: RouteHandler = async ({ locals, params }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  try {
    await promotionService.delete(user.id, params.id!);
    return new Response(null, { status: 204 });
  } catch (error: any) {
    if (error instanceof EntitlementDeniedError) return entitlementResponse(error.decision);
    if (error.message === 'NOT_FOUND') {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }
    console.error('[merchant/promotions DELETE]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
