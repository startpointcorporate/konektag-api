// Bootstrap : initialise tous les adapters et services au démarrage

import { KeycloakAdapter } from './adapters/keycloak-adapter.ts';
import { RedisAdapter } from './adapters/redis-adapter.ts';
import { MinioAdapter } from './adapters/minio-adapter.ts';
import { EncryptionService } from './adapters/encryption-service.ts';

// ── Adapters (singletons) ────────────────────────────

export const keycloakAdapter = new KeycloakAdapter(
  process.env.KEYCLOAK_BASE_URL ?? 'http://common-keycloak:8080',
  process.env.KEYCLOAK_REALM ?? 'konektag',
  process.env.KEYCLOAK_CLIENT_ID ?? 'frontend-konektag',
  process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'directus-konektag',
  process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? '',
);

export const redisAdapter = new RedisAdapter(
  process.env.REDIS_URL ?? (process.env.REDIS_PASSWORD
    ? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@common-redis:6379`
    : 'redis://common-redis:6379'),
);

export const minioAdapter = new MinioAdapter(
  process.env.MINIO_ENDPOINT ?? 'common-minio',
  parseInt(process.env.MINIO_PORT ?? '9000'),
  process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  process.env.MINIO_SECRET_KEY ?? '',
  process.env.MINIO_BUCKET ?? 'konektag',
);

export const encryptionService = EncryptionService.fromEnv();

// ── Initialisation au démarrage ───────────────────────

let initialized = false;

export async function bootstrap(): Promise<void> {
  if (initialized) return;
  initialized = true;

  console.log('[Bootstrap] Connecting to services...');

  // Migrations are now run as a separate Compose service (see docker-compose.yml).
  // The application no longer executes DDL on first request. The migration
  // service must complete with exit 0 before the frontend starts.
  console.log('[Bootstrap] Skipping auto-migration — migrations run as a separate service');

  await redisAdapter.connect();
  console.log('[Bootstrap] Redis connected');
  // Accounting worker is started as a standalone process (accounting-worker-entry.ts).
  // Do NOT start it from bootstrap — see accounting-worker Compose service.
  console.log('[Bootstrap] Ready');
}

bootstrap().catch(err => console.error('[Bootstrap] Failed:', err));
