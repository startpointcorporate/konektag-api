export function isSecureContext(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // In production behind ingress, upstream may see http while client is HTTPS.
    // Treat any non-local host as secure to keep auth cookies protected.
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function tokenCookieOptions(url?: string, maxAge?: number) {
  const secure = isSecureContext(url);
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAge ? { maxAge } : {}),
  };
}
