import type { RouteHandler } from '../../http';
import { erpnext } from '../../../infrastructure/adapters/erpnext-adapter.ts';

interface ErpCountryRow { name?: unknown; code?: unknown }

export const GET: RouteHandler = async () => {
  try {
    const countries: ErpCountryRow[] = await erpnext.list('Country', undefined, ['name', 'code'], 500);
    const result = countries
      .filter((country): country is { name: string; code: string } =>
        typeof country.name === 'string' && typeof country.code === 'string' && /^[A-Z]{2}$/i.test(country.code))
      .map(country => ({ code: country.code.toUpperCase(), name: country.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return Response.json({ countries: result });
  } catch {
    return Response.json({ error: 'COUNTRIES_UNAVAILABLE' }, { status: 503 });
  }
};
