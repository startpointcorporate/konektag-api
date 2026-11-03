import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { MerchantLocationRequiredError, MerchantProfileNotFoundError, MerchantSlugTakenError } from '../../../domain/MerchantErrors.ts';
import { z } from 'zod';

const CreateSchema = z.object({
  businessName: z.string().min(1).max(200),
  shortDescription: z.string().max(500).optional(),
  longDescription: z.string().max(5000).optional(),
  address: z.string().max(300).optional(),
  // Merchant location invariant: country and city are always required.
  city: z.string().trim().min(1).max(100),
  country: z.string().trim().min(1).max(100),
  phone: z.string().max(30).optional(),
  email: z.string().email().max(200).optional(),
  websiteUrl: z.string().url().max(500).optional(),
});

const UpdateSchema = z.object({
  profileId: z.string().uuid().optional(),
  businessName: z.string().min(1).max(200).optional(),
  logoUrl: z.string().max(500).nullish(),
  coverImageUrl: z.string().max(500).nullish(),
  shortDescription: z.string().max(500).nullish(),
  longDescription: z.string().max(5000).nullish(),
  address: z.string().max(300).nullish(),
  // Location can be changed but never cleared.
  city: z.string().trim().min(1).max(100).optional(),
  country: z.string().trim().min(1).max(100).optional(),
  neighborhood: z.string().max(100).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().max(200).nullish(),
  websiteUrl: z.string().url().max(500).nullish(),
  seoTitle: z.string().max(70).nullish(),
  seoDescription: z.string().max(180).nullish(),
  seoCanonicalUrl: z.string().url().max(500).nullish(),
  ogTitle: z.string().max(95).nullish(),
  ogDescription: z.string().max(300).nullish(),
  ogImageUrl: z.string().url().max(500).nullish(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const GET: RouteHandler = async ({ locals, url }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profileId = url.searchParams.get('profileId');
    const profile = profileId ? await merchantService.getManagedProfile(user.id, profileId) : await merchantService.getProfile(user.id);
    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[merchant/profile GET]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
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
    const profile = await merchantService.createProfile(user.id, parsed.data);
    return new Response(JSON.stringify(profile), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error.message === 'MERCHANT_ALREADY_EXISTS') {
      return new Response(JSON.stringify({ error: 'ALREADY_EXISTS', message: 'You already have a merchant profile' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (error instanceof MerchantSlugTakenError) {
      return new Response(JSON.stringify({ error: 'SLUG_TAKEN', message: error.message }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (error instanceof MerchantLocationRequiredError) {
      return new Response(JSON.stringify({ error: error.code, missing: error.missing, message: error.message }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[merchant/profile POST]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const PUT: RouteHandler = async ({ request, locals }) => {
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
    if (parsed.data.profileId) await merchantService.requireOwnerOrManager(parsed.data.profileId, user.id);
    const profile = await merchantService.updateProfile(user.id, parsed.data);
    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (error instanceof MerchantLocationRequiredError) {
      return new Response(JSON.stringify({ error: error.code, missing: error.missing, message: error.message }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[merchant/profile PUT]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
