import type { RouteHandler } from '../../http';
import { reviewService } from '../../../application/services/review-service.ts';

export const POST: RouteHandler = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

  try {
    const body = await request.json();
    const { merchantSlug, rating, comment } = body;

    if (!merchantSlug || !rating) {
      return new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'merchantSlug et rating requis' }), { status: 400 });
    }

    const ratingNum = parseInt(rating, 10);
    if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return new Response(JSON.stringify({ error: 'BAD_REQUEST', message: 'La note doit être entre 1 et 5' }), { status: 400 });
    }

    const review = await reviewService.createReview(user.id, merchantSlug, ratingNum, comment);

    return new Response(JSON.stringify({ review }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[reviews/create]', error);
    return new Response(JSON.stringify({ error: 'REVIEW_ERROR', message: error.message }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
