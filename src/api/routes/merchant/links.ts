import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantProfileNotFoundError } from '../../../domain/MerchantErrors.ts';
import { z } from 'zod';

const LinkSchema = z.object({
  label: z.string().min(1).max(100),
  url: z.string().url().max(500),
  linkType: z.enum(['Website', 'Instagram', 'Facebook', 'TikTok', 'YouTube', 'Booking', 'Menu', 'Catalog', 'Other']),
});

const BodySchema = z.object({
  links: z.array(LinkSchema).max(20),
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
    await merchantService.saveExternalLinks(user.id, parsed.data.links.map((l, i) => ({ ...l, displayOrder: i })));
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });
    }
    console.error('[merchant/links]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
