import { z } from 'zod';
import { ActivityCodeSchema } from '../../../application/merchant-activity-profile.ts';
import { MerchantNotOwnerError, MerchantActivationRequiredError } from '../../../domain/MerchantErrors.ts';
import type { RouteHandler } from '../../http';
import { merchantService } from '../../../application/merchant-service.ts';
import { notifyIndexNow } from '../../../application/shared/indexnow.ts';
import { getSiteUrl } from '../../../application/shared/seo.ts';
import { marketplaceActivityPath } from '../../../application/shared/marketplace/slug.ts';
import { MerchantProfileNotFoundError, MerchantCannotPublishError, MerchantLocationRequiredError } from '../../../domain/MerchantErrors.ts';

export const POST: RouteHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  const parsed = z.object({ activityCode: ActivityCodeSchema, merchantProfileId: z.string().uuid().optional() }).safeParse(body);
  if (!parsed.success) return new Response(JSON.stringify({ errors: parsed.error.flatten().fieldErrors }), { status: 422 });

  try {
    const profile = await merchantService.publishProfile(user.id, parsed.data.activityCode, parsed.data.merchantProfileId);
    const urls=['fr','en','ar','pt','es','sw','ha','yo','zh','hi'].map(locale=>getSiteUrl()+marketplaceActivityPath(locale,profile.city||'',parsed.data.activityCode,profile.slug));
    notifyIndexNow(urls).catch(e=>console.error('[IndexNow] publish activity',e));
    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    if (error instanceof MerchantNotOwnerError || error instanceof MerchantActivationRequiredError) {
      return new Response(JSON.stringify({ error: error.code, message: error.message }), { status: 403 });
    }
    if (error instanceof MerchantProfileNotFoundError) {
      return new Response(JSON.stringify({ error: 'NOT_FOUND', message: error.message }), { status: 404 });
    }
    if (error instanceof MerchantLocationRequiredError) {
      return new Response(JSON.stringify({ error: error.code, missing: error.missing, message: error.message }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (error instanceof MerchantCannotPublishError) {
      return new Response(JSON.stringify({ error: 'CANNOT_PUBLISH', message: error.message }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[merchant/publish]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
