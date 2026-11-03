import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicOrigin } from '../../src/application/shared/public-origin.ts';

describe('getPublicOrigin', () => {
  const originalPublicSiteUrl = process.env.PUBLIC_SITE_URL;

  afterEach(() => {
    if (originalPublicSiteUrl === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = originalPublicSiteUrl;
    vi.unstubAllEnvs();
  });

  it('preserves the request origin for local development and test servers', () => {
    expect(getPublicOrigin('http://127.0.0.1:4323', true)).toBe('http://127.0.0.1:4323');
  });

  it('uses the configured canonical HTTPS origin in production', () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'https://app.example.test/');
    expect(getPublicOrigin('http://localhost:4331', false)).toBe('https://app.example.test');
  });

  it('never exposes an internal request origin in production when configuration is absent', () => {
    delete process.env.PUBLIC_SITE_URL;
    expect(getPublicOrigin('http://localhost:4331', false)).toBe('https://www.konektag.eu');
  });

  it('rejects a non-HTTPS production configuration', () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'http://localhost:4331');
    expect(getPublicOrigin('http://localhost:4331', false)).toBe('https://www.konektag.eu');
  });
});
