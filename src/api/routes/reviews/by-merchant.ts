import type { RouteHandler } from '../../http';
import { reviewService } from '../../../application/services/review-service.ts';

export const GET: RouteHandler = async ({ request }) => {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  const limit = Math.max(1,Math.min(100,parseInt(url.searchParams.get('limit') || '10')||10));
  const offset = Math.max(0,parseInt(url.searchParams.get('offset') || '0')||0);

  if (!slug) {
    return new Response(JSON.stringify({ reviews: [], total: 0, averageRating: 0 }), { status: 200 });
  }

  try {
    const result = await reviewService.getMerchantReviews(slug, limit, offset);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[reviews/by-merchant] Loading failed');
    return Response.json({error:'REVIEWS_UNAVAILABLE'},{status:503});
  }
};

