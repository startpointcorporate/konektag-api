import type { CountryResponse } from 'maxmind';

let reader: Promise<{ get: (ip: string) => CountryResponse | null }> | null = null;

function clientIp(request: Request): string | null {
  const value = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || null;
  if (!value || value === '::1' || value.startsWith('127.') || value.startsWith('10.')
    || value.startsWith('192.168.') || value.startsWith('172.16.')) return null;
  return value.replace(/^::ffff:/, '');
}

async function database() {
  const path = process.env.GEOLITE2_COUNTRY_DB_PATH;
  if (!path) return null;
  reader ??= import('maxmind').then(({ open }) => open<CountryResponse>(path));
  try { return await reader; } catch { return null; }
}

export async function detectCountry(request: Request): Promise<string | null> {
  const ip = clientIp(request);
  if (!ip) return null;
  const db = await database();
  const country = db?.get(ip)?.country?.iso_code?.toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}
