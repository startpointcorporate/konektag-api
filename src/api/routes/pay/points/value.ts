import type { RouteHandler } from '../../../http';
import { PointsKValuationError, quoteOnePointK, valuePointsK } from '../../../../application/services/points-k-valuation-service.ts';

const CURRENCY_RE = /^[A-Z]{3}$/;

export const GET: RouteHandler = async ({ request }) => {
  const url = new URL(request.url);
  const currency = (url.searchParams.get('currency') ?? 'EUR').trim().toUpperCase();

  if (!CURRENCY_RE.test(currency)) {
    return Response.json({ error: 'currency must be a 3-letter ISO code' }, { status: 400 });
  }

  try {
    return Response.json(await quoteOnePointK(currency));
  } catch (error) {
    if (error instanceof PointsKValuationError) {
      return Response.json({ error: error.code }, { status: 422 });
    }
    return Response.json({ error: 'POINTS_K_VALUATION_UNAVAILABLE' }, { status: 503 });
  }
};

export const POST: RouteHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const currency = String(body?.currency ?? '').trim().toUpperCase();
    const amountMinor = Number(body?.amountMinor);
    if (!CURRENCY_RE.test(currency) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0)
      return Response.json({ error: 'INVALID_VALUATION_REQUEST' }, { status: 400 });
    return Response.json(await valuePointsK({ sourceCurrency: currency, sourceAmountMinor: amountMinor, context: 'qr-online' }));
  } catch (error) {
    if (error instanceof PointsKValuationError) return Response.json({ error: error.code }, { status: 422 });
    return Response.json({ error: 'POINTS_K_VALUATION_UNAVAILABLE' }, { status: 503 });
  }
};
