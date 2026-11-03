import type { RouteHandler } from '../../http';
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

export const GET: RouteHandler = async ({ url }) => {
  const key = url.searchParams.get('key');
  if (!key || !key.startsWith('qr/')) return new Response(null, { status: 404 });

  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: process.env.MINIO_BUCKET ?? 'konektag',
      Key: key,
    }));
    if (!result.Body) return new Response(null, { status: 404 });

    const chunks: Uint8Array[] = [];
    for await (const chunk of result.Body as any) chunks.push(chunk);
    return new Response(Buffer.concat(chunks), {
      headers: {
        'Content-Type': result.ContentType ?? 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error: any) {
    if (error.name === 'NoSuchKey') return new Response(null, { status: 404 });
    console.error('[qr-code-file proxy]', error);
    return new Response(null, { status: 500 });
  }
};
