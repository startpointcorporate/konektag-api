import type { RouteHandler } from '../../http';
import {canReadMerchantMedia} from '../../../application/services/public-merchant-media.ts';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: `http://${process.env.MINIO_ENDPOINT ?? 'common-minio'}:${process.env.MINIO_PORT ?? '9000'}`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
  },
  forcePathStyle: true,
});

export const GET: RouteHandler = async ({ url,locals }) => {
  const key = url.searchParams.get('key');
  if (!key) return new Response(null, { status: 404 });

  const bucket = process.env.MINIO_BUCKET ?? 'konektag';

  try {
    if(!await canReadMerchantMedia(key,locals.user?.id))return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}});
    const result = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));

    const body = result.Body;
    if (!body) return new Response(null, { status: 404 });

    const chunks: Uint8Array[] = [];
    for await (const chunk of body as any) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': result.ContentType ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err: any) {
    if (err.name === 'NoSuchKey') return new Response(null, { status: 404 });
    console.error('[media-file proxy]', err);
    return new Response(null, { status: 500 });
  }
};
