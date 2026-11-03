import { RetryableError, OnboardingError } from '../../domain/DomainErrors.ts';
import { getCorrelationId } from '../correlation-id.ts';

interface KeycloakUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  phone: string;
  locale: string;
  requiredActions: string[];
  attributes: Record<string, string>;
  emailVerified?: boolean;
}

/** Subset of the Keycloak admin user representation read by the application. */
export interface KeycloakUserRepresentation {
  email?: string;
  attributes?: Record<string, string[]>;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

interface JWTPayload {
  sub: string;
  email_verified: boolean;
  exp: number;
  iat: number;
  [key: string]: unknown;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class KeycloakAdapter {
  private adminToken: string | null = null;
  private adminTokenExpiry = 0;

  constructor(
    private baseUrl: string,
    private realm: string,
    private clientId: string,
    private adminClientId: string,
    private adminClientSecret: string,
    private externalBaseUrl?: string,
  ) {
    this.externalBaseUrl ||= baseUrl;
  }

  private async getAdminToken(): Promise<string> {
    if (this.adminToken && Date.now() < this.adminTokenExpiry) {
      return this.adminToken;
    }

    const res = await fetch(
      `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.adminClientId,
          client_secret: this.adminClientSecret,
        }),
      },
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string; error_description?: string };
      throw new Error(`Keycloak admin token request failed: ${res.status} ${JSON.stringify({
        endpoint: `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
        error: data.error ?? null,
        error_description: data.error_description ?? null,
      })}`);
    }
    const data = await res.json();
    this.adminToken = data.access_token;
    this.adminTokenExpiry = Date.now() + (data.expires_in - 30) * 1000;
    return this.adminToken!;
  }

  async createUser(input: KeycloakUserInput): Promise<string> {
    let lastError: Error | undefined;

    for (let i = 0; i <= 3; i++) {
      try {
        const res = await fetch(
          `${this.baseUrl}/admin/realms/${this.realm}/users`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${await this.getAdminToken()}`,
              'Content-Type': 'application/json',
              'X-Correlation-Id': getCorrelationId(),
            },
            body: JSON.stringify({
              username: input.username,
              email: input.email,
              firstName: input.firstName,
              lastName: input.lastName,
              credentials: [{ type: 'password', value: input.password, temporary: false }],
              attributes: input.attributes,
              requiredActions: input.requiredActions,
              enabled: true,
              emailVerified: input.emailVerified !== undefined ? input.emailVerified : false,
            }),
            signal: AbortSignal.timeout(10000),
          },
        );

        if (res.status === 409) {
          throw new OnboardingError('USERNAME_OR_EMAIL_EXISTS');
        }

        if (!res.ok) {
          throw new RetryableError(`Keycloak createUser: ${res.status}`);
        }

        const location = res.headers.get('Location');
        if (!location) throw new Error('Keycloak: no Location header');
        return location.split('/').pop()!;
      } catch (err) {
        lastError = err as Error;
        if (err instanceof OnboardingError) throw err;
        if (i < 3) await sleep(Math.min(1000 * Math.pow(2, i), 4000));
      }
    }

    throw lastError!;
  }

  async deleteUser(keycloakId: string): Promise<void> {
    await fetch(
      `${this.baseUrl}/admin/realms/${this.realm}/users/${keycloakId}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${await this.getAdminToken()}` },
      },
    );
  }

  async directGrant(username: string, password: string): Promise<Tokens> {
    const res = await fetch(
      `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: this.clientId,
          username,
          password,
        }),
      },
    );

    if (!res.ok) throw new OnboardingError('AUTHENTICATION_FAILED');
    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }

  async exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<Tokens> {
    const res = await fetch(
      `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
      },
    );

    if (!res.ok) throw new Error('Code exchange failed');
    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }

  async refreshToken(refreshToken: string): Promise<Tokens> {
    const res = await fetch(
      `${this.baseUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.clientId,
          refresh_token: refreshToken,
        }),
      },
    );

    if (!res.ok) throw new Error('Token refresh failed');
    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
    };
  }

  async validateToken(accessToken: string): Promise<JWTPayload | null> {
    try {
      const { jwtVerify, createRemoteJWKSet } = await import('jose');
      const JWKS = createRemoteJWKSet(
        new URL(`${this.externalBaseUrl}/realms/${this.realm}/protocol/openid-connect/certs`)
      );
      const { payload } = await jwtVerify(accessToken, JWKS, {
        issuer: `${this.externalBaseUrl}/realms/${this.realm}`,
      });
      return payload as unknown as JWTPayload;
    } catch (e) {
      console.error('[keycloak] Token validation error:', e);
      return null;
    }
  }

  /** Returns the admin representation of a user, or null when Keycloak does not return it. */
  async getUser(keycloakId: string): Promise<KeycloakUserRepresentation | null> {
    const token = await this.getAdminToken();
    const res = await fetch(
      `${this.baseUrl}/admin/realms/${this.realm}/users/${keycloakId}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    return res.json();
  }

  async updateUserAttributes(
    keycloakId: string,
    attributes: Record<string, string>,
  ): Promise<void> {
    const token = await this.getAdminToken();
    const getRes = await fetch(
      `${this.baseUrl}/admin/realms/${this.realm}/users/${keycloakId}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    if (!getRes.ok) throw new Error(`Failed to get user ${keycloakId}`);

    const user = await getRes.json();
    const merged: Record<string, string[]> = {};
    if (user.attributes) {
      for (const [k, v] of Object.entries(user.attributes)) {
        merged[k] = v as string[];
      }
    }
    for (const [key, value] of Object.entries(attributes)) {
      merged[key] = [value];
    }

    const { id, access, createdTimestamp, ...safe } = user;
    safe.attributes = merged;

    await fetch(
      `${this.baseUrl}/admin/realms/${this.realm}/users/${keycloakId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(safe),
      },
    );
  }

  async setUserEnabled(keycloakId: string, enabled: boolean): Promise<void> {
    const token = await this.getAdminToken();
    const url = `${this.baseUrl}/admin/realms/${this.realm}/users/${keycloakId}`;
    const current = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!current.ok) throw new Error(`Failed to get user ${keycloakId}`);
    const user = await current.json();
    const { id, access, createdTimestamp, ...safe } = user;
    safe.enabled = enabled;
    const result = await fetch(url, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(safe) });
    if (!result.ok) throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} user ${keycloakId}`);
  }

  async resetPassword(keycloakId: string, newPassword: string): Promise<void> {
    const token = await this.getAdminToken();
    const res = await fetch(
      `${this.baseUrl}/admin/realms/${this.realm}/users/${keycloakId}/reset-password`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'password',
          value: newPassword,
          temporary: false,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Keycloak password reset failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }
}

const keycloakBaseUrl = process.env.KEYCLOAK_BASE_URL ?? 'http://common-keycloak:8080';
const keycloakExternalBaseUrl = process.env.KEYCLOAK_EXTERNAL_BASE_URL || process.env.PUBLIC_SITE_URL || 'https://login.konektag.eu';
const realm = process.env.KEYCLOAK_REALM ?? 'konektag';
const clientId = process.env.KEYCLOAK_CLIENT_ID ?? 'frontend-konektag';
const adminClientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? 'directus-konektag';
const adminClientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? '';
export const keycloakAdapter = new KeycloakAdapter(keycloakBaseUrl, realm, clientId, adminClientId, adminClientSecret, keycloakExternalBaseUrl);
