import type { RouteHandler } from '../../../http';

export const POST: RouteHandler = async () =>
  Response.json(
    { error: 'LEGACY_MANUAL_ACQUISITION_RETIRED', replacement: '/api/admin/mobile-money-queue/api-payments/{id}/confirm' },
    { status: 410 },
  );
