import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeycloakAdapter } from '../../src/infrastructure/adapters/keycloak-adapter.ts';

describe('KeycloakAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the token endpoint and Keycloak error without exposing client credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_client', error_description: 'Invalid client credentials',
    }), { status: 401 })));
    const adapter = new KeycloakAdapter('https://login.konektag.eu/auth', 'konektag', 'frontend-konektag', 'directus-konektag', 'secret-value');

    await expect((adapter as any).getAdminToken()).rejects.toThrow(
      'Keycloak admin token request failed: 401 {"endpoint":"https://login.konektag.eu/auth/realms/konektag/protocol/openid-connect/token","error":"invalid_client","error_description":"Invalid client credentials"}',
    );
  });
});
