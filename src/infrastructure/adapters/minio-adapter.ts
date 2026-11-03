import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';
import { RetryableError } from '../../domain/DomainErrors.ts';

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

export class MinioAdapter {
  private s3: S3Client;

  constructor(
    endpoint: string,
    port: number,
    accessKey: string,
    secretKey: string,
    private bucket: string,
  ) {
    this.s3 = new S3Client({
      endpoint: `http://${endpoint}:${port}`,
      region: 'us-east-1',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true,
    });
  }

  async uploadQuarantine(userId: string, file: FileInput, docType: string): Promise<string> {
    const ext = file.originalName.split('.').pop() ?? 'bin';
    const key = `kyc/quarantine/${userId}/${docType}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const metadata = {
      user_id: userId,
      uploaded_at: new Date().toISOString(),
      sha256: hash,
      size: String(file.buffer.length),
    };

    return withRetry(async () => {
      await this.s3.send(new PutObjectCommand({
        Bucket: process.env.MINIO_QUARANTINE_BUCKET || this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimeType,
        Metadata: metadata,
      }));

      return key;
    });
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    await withRetry(() => this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
  }

  async getPresignedUrl(bucket: string, key: string, expiresIn = 900): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }), { expiresIn });
  }

  async findReadableBucket(key: string, buckets: string[]): Promise<string> {
    const uniqueBuckets = Array.from(new Set(buckets.filter(Boolean)));
    let lastError: unknown;
    for (const bucket of uniqueBuckets) {
      try {
        await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-0' }));
        console.info('[kyc-storage] source found', { bucket, key });
        return bucket;
      } catch (error) {
        lastError = error;
        console.info('[kyc-storage] source not found/readable', {
          bucket,
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError || new Error('KYC_DOCUMENT_NOT_FOUND');
  }

  async moveToDefinitive(
    quarantineKey: string,
    kycOrderId: string,
    sourceBucket = process.env.MINIO_QUARANTINE_BUCKET || this.bucket,
    destinationBucket = process.env.MINIO_KYC_BUCKET || this.bucket,
  ): Promise<string> {
    const definitiveKey = quarantineKey.replace(/^kyc\/quarantine\//, `kyc/verified/${kycOrderId}/`);

    try {
      console.info('[kyc-storage] copy start', { sourceBucket, destinationBucket, sourceKey: quarantineKey, destinationKey: definitiveKey });
      await this.s3.send(new CopyObjectCommand({
        Bucket: destinationBucket,
        Key: definitiveKey,
        CopySource: encodeURI(`${sourceBucket}/${quarantineKey}`),
      }));
      console.info('[kyc-storage] copy ok', { sourceBucket, destinationBucket, sourceKey: quarantineKey, destinationKey: definitiveKey });
    } catch (error) {
      console.error('[kyc-storage] copy failed', {
        sourceBucket, destinationBucket, sourceKey: quarantineKey, destinationKey: definitiveKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    try {
      console.info('[kyc-storage] delete source start', { sourceBucket, sourceKey: quarantineKey });
      await this.s3.send(new DeleteObjectCommand({
        Bucket: sourceBucket,
        Key: quarantineKey,
      }));
      console.info('[kyc-storage] delete source ok', { sourceBucket, sourceKey: quarantineKey });
    } catch (error) {
      console.error('[kyc-storage] delete source failed', {
        sourceBucket, sourceKey: quarantineKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return definitiveKey;
  }

  async moveToRejected(
    quarantineKey: string,
    sourceBucket = process.env.MINIO_QUARANTINE_BUCKET || this.bucket,
    destinationBucket = process.env.MINIO_REJECTED_BUCKET || this.bucket,
  ): Promise<string> {
    const rejectedKey = quarantineKey.replace(/^kyc\/quarantine\//, 'kyc/rejected/');

    await this.s3.send(new CopyObjectCommand({
      Bucket: destinationBucket,
      Key: rejectedKey,
      CopySource: encodeURI(`${sourceBucket}/${quarantineKey}`),
    }));

    await this.s3.send(new DeleteObjectCommand({
      Bucket: sourceBucket,
      Key: quarantineKey,
    }));

    return rejectedKey;
  }

  async downloadFromBucket(bucket: string, key: string): Promise<Buffer> {
    const response = await this.s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
    return Buffer.from(await response.Body!.transformToByteArray());
  }
}

const minioEndpoint = process.env.MINIO_ENDPOINT ?? 'common-minio';
const minioPort = parseInt(process.env.MINIO_PORT ?? '9000');
const minioAccessKey = process.env.MINIO_ACCESS_KEY ?? 'minioadmin';
const minioSecretKey = process.env.MINIO_SECRET_KEY ?? '';
const bucket = process.env.MINIO_BUCKET ?? 'konektag';
export const minioAdapter = new MinioAdapter(minioEndpoint, minioPort, minioAccessKey, minioSecretKey, bucket);
