import type { RouteHandler } from '../../../http';
import { offlineRequest } from '../../../../application/shared/offline-pay/http.ts';
import { synchronizePaymentBatch } from '../../../../application/offline-payment-sync-service.ts';
export const POST: RouteHandler = context => offlineRequest(context, synchronizePaymentBatch);
