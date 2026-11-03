import type { RouteHandler } from '../../http';
import { detectCountry } from '../../../application/services/pay/detected-country-service.ts';

export const GET: RouteHandler = async ({ request }) => Response.json({ detectedCountry: await detectCountry(request) });
