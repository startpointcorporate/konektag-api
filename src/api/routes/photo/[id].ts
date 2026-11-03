import type { RouteHandler } from '../../http';
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../../infrastructure/database/pool.ts';
import {publicMarketplaceCtes} from '../../../application/services/public-marketplace-sql.ts';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const FALLBACK_PATH = process.env.PHOTO_FALLBACK_PATH || path.join(process.cwd(), 'dist', 'assets', 'photo-restaurant.jpg');

export const GET: RouteHandler = async ({ params }) => {
  const merchantId = params.id as string;
  if (!merchantId) return serveFallback();
  if (merchantId.length > 40) return serveFallback(); // not a UUID

  let photoName: string | null = null;
  try {
    const { rows } = await pool.query(
      `${publicMarketplaceCtes} SELECT snapshot->'merchant'->'photoUrls'->>0 AS photo FROM public_n2 WHERE merchant_profile_id=$1`,
      [merchantId],
    );
    if (rows.length && rows[0].photo) {
      // Extract the photo resource name from stored URL (/api/photo/places/...)
      const stored = rows[0].photo as string;
      const m = stored.match(/\/api\/photo\/(places\/[^/]+\/photos\/[^/]+)/);
      if (m) photoName = m[1];
    }
  } catch { /* ignore */ }

  if (!photoName) return serveFallback();

  const url = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=400&maxWidthPx=600&key=${GOOGLE_API_KEY}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return serveFallback();

    const blob = await res.blob();
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return new Response(blob, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch {
    return serveFallback();
  }
};

function serveFallback(): Response {
  try {
    if (fs.existsSync(FALLBACK_PATH)) {
      const buf = fs.readFileSync(FALLBACK_PATH);
      return new Response(buf, {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
      });
    }
  } catch {}
  return new Response(null, { status: 404 });
}
