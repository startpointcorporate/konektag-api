import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { minioAdapter } from '../../../../infrastructure/adapters/minio-adapter.ts';

const ADMIN_CHECK = `SELECT role FROM konektag.users WHERE id = $1`;

export const GET: RouteHandler = async ({ locals, request }) => {
  const user = (locals as any).user;
  if (!user) return new Response(null, { status: 401 });
  const { rows: [u] } = await pool.query(ADMIN_CHECK, [user.id]);
  if (!u || u.role !== 'admin') return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });

  const url = new URL(request.url);
  const orderId = url.searchParams.get('orderId');
  if (!orderId) return new Response(JSON.stringify({ error: 'MISSING_orderId' }), { status: 400 });

  try {
    const { rows: [order] } = await pool.query(
      `SELECT id_document_path, status FROM konektag.kyc_orders WHERE id = $1`,
      [orderId],
    );
    if (!order) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 });

    // Historical KYC orders may live in the dedicated quarantine bucket, while newer
    // uploads can live in the adapter's configured bucket. Try the bucket matching the
    // order lifecycle first, then the configured bucket for compatibility.
    const configuredBucket = process.env.MINIO_BUCKET || 'konektag';
    const lifecycleBucket = order.status === 'verified'
      ? (process.env.MINIO_KYC_BUCKET || configuredBucket)
      : (process.env.MINIO_QUARANTINE_BUCKET || 'konektag-kyc-quarantine');
    const buckets = Array.from(new Set([lifecycleBucket, configuredBucket]));

    let document: Buffer | null = null;
    let lastError: unknown;
    for (const bucket of buckets) {
      try {
        document = await minioAdapter.downloadFromBucket(bucket, order.id_document_path);
        break;
      } catch (error) {
        lastError = error;
        console.warn('[admin/kyc/document] object not found/readable in bucket', {
          orderId,
          bucket,
          key: order.id_document_path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!document) throw lastError || new Error('KYC_DOCUMENT_NOT_FOUND');
    const extension = String(order.id_document_path || '').split('.').pop()?.toLowerCase();
    const contentType =
      extension === 'png' ? 'image/png' :
      extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' :
      extension === 'pdf' ? 'application/pdf' :
      'application/octet-stream';

    return new Response(new Uint8Array(document), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error: any) {
    console.error('[admin/kyc/document]', error);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
