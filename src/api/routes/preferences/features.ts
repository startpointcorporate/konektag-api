import type { RouteHandler } from '../../http';
import { preferencesService } from '../../../application/services/preferences-service.ts';

export const GET: RouteHandler = async () => {
  const features = await preferencesService.getFeatures();
  return new Response(
    JSON.stringify(features),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
