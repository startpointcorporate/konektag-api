import crypto from 'node:crypto';

export class EncryptionService {
  private readonly algorithm = 'aes-256-gcm';

  constructor(private key: Buffer) {}

  static fromEnv(): EncryptionService {
    const keyB64 = process.env.DATA_ENCRYPTION_KEY;
    if (!keyB64) throw new Error('DATA_ENCRYPTION_KEY not set');
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (AES-256)');
    return new EncryptionService(key);
  }

  encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Format: [1 byte version][12 bytes iv][16 bytes tag][ciphertext...]
    const version = Buffer.from([1]);
    return Buffer.concat([version, iv, tag, encrypted]);
  }

  decrypt(data: Buffer): string {
    const version = data[0];
    if (version !== 1) throw new Error(`Unsupported encryption version: ${version}`);

    const iv = data.subarray(1, 13);
    const tag = data.subarray(13, 29);
    const encrypted = data.subarray(29);

    const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }
}

