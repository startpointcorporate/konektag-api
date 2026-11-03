import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (i < maxRetries) await sleep(Math.min(1000 * Math.pow(2, i), 4000));
    }
  }
  throw lastError!;
}

export interface FileInput {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

export class MerchantMediaStorage {
  private s3: S3Client;
  private bucket: string;
  private internalEndpoint: string;
  private publicEndpoint: string;

  constructor(endpoint: string, port: number, accessKey: string, secretKey: string) {
    this.internalEndpoint = `http://${endpoint}:${port}`;
    this.publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT ?? this.internalEndpoint;
    this.s3 = new S3Client({
      endpoint: this.internalEndpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true,
    });
    // RustFS production uses one physical bucket; merchant media and QR are isolated by key prefixes.
    this.bucket = process.env.MINIO_BUCKET ?? 'konektag';
  }

  async uploadMedia(merchantProfileId: string, file: FileInput): Promise<{ key: string; url: string }> {
    const ext = file.originalName.split('.').pop() ?? 'bin';
    const key = `merchant/${merchantProfileId}/${crypto.randomBytes(8).toString('hex')}-${Date.now()}.${ext}`;

    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const metadata = {
      merchant_id: merchantProfileId,
      uploaded_at: new Date().toISOString(),
      sha256: hash,
      size: String(file.buffer.length),
    };

    return withRetry(async () => {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimeType,
        Metadata: metadata,
      }));
      const url = `/api/merchant/media-file?key=${encodeURIComponent(key)}`;
      return { key, url };
    });
  }

  async deleteMedia(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }

  async getPresignedUrl(bucket: string, key: string, expiresIn = 3600): Promise<string> {
    const url = await getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }), { expiresIn });
    if (this.publicEndpoint !== this.internalEndpoint) {
      return url.replace(this.internalEndpoint, this.publicEndpoint);
    }
    return url;
  }

  async uploadQrCode(merchantProfileId: string, buffer: Buffer): Promise<{ key: string; url: string }> {
    const key = `qr/${merchantProfileId}/qr-code-${Date.now()}.png`;

    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
    }));

    const url = `/api/merchant/qr-code-file?key=${encodeURIComponent(key)}`;
    return { key, url };
  }

  getPublicUrl(bucket: string, key: string): string {
    return `${this.publicEndpoint}/${bucket}/${key}`;
  }
}

const minioEndpoint = process.env.MINIO_ENDPOINT ?? 'common-minio';
const minioPort = parseInt(process.env.MINIO_PORT ?? '9000', 10);
const minioAccessKey = process.env.MINIO_ACCESS_KEY ?? 'minioadmin';
const minioSecretKey = process.env.MINIO_SECRET_KEY ?? '';

export const merchantMediaStorage = new MerchantMediaStorage(minioEndpoint, minioPort, minioAccessKey, minioSecretKey);
