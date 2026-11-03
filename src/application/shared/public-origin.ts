const PRODUCTION_PUBLIC_ORIGIN = 'https://www.konektag.eu';

function normalizeHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The container's request origin is an internal address in production. OIDC
 * redirect URIs must instead use the browser-visible, canonical HTTPS origin.
 */
export function getPublicOrigin(requestOrigin: string, isDevelopment: boolean): string {
  if (isDevelopment) return requestOrigin;

  return normalizeHttpsOrigin(process.env.PUBLIC_SITE_URL || '') || PRODUCTION_PUBLIC_ORIGIN;
}
