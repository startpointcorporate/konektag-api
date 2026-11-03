import { ActivityCodeSchema } from '../../../application/merchant-activity-profile.ts';
import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError, MerchantNotOwnerError } from '../../../domain/MerchantErrors.ts';
import { z } from 'zod';

const HourSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  openTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  isClosed: z.boolean(),
  breakStartTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  breakEndTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  openTime2: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  closeTime2: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});

const BodySchema = z.object({
  merchantProfileId: z.string().uuid().optional(),
  activityCode: ActivityCodeSchema.nullish(),
  hours: z.array(HourSchema).max(7).refine(hours => new Set(hours.map(h => h.dayOfWeek)).size === hours.length, 'Duplicate day'),
});

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await merchantService.saveOpeningHours(user.id, parsed.data.hours as any, parsed.data.activityCode, parsed.data.merchantProfileId);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantNotOwnerError) return new Response(JSON.stringify({ error: error.code }), { status: 403 });
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }
    console.error('[merchant/opening-hours]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};

export const GET: RouteHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  const query = new URL(request.url).searchParams;
  const parsed = z.object({
    activityCode: ActivityCodeSchema.nullish(),
    merchantProfileId: z.string().uuid().nullish(),
  }).safeParse({ activityCode: query.get('activityCode'), merchantProfileId: query.get('merchantProfileId') });
  if (!parsed.success) return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422 });
  try {
    const hours = await merchantService.getOpeningHours(locals.user.id, parsed.data.activityCode, parsed.data.merchantProfileId ?? undefined);
    return new Response(JSON.stringify({ hours }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    if (error instanceof MerchantNotOwnerError) return new Response(JSON.stringify({ error: error.code }), { status: 403 });
    if (error instanceof MerchantProfileNotFoundError) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    console.error('[merchant/opening-hours GET]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
