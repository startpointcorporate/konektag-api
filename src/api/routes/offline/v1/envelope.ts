import type { RouteHandler } from '../../../http';
import { z } from 'zod';
import { offlineRequest } from '../../../../application/shared/offline-pay/http.ts';
import { issuePaymentEnvelope } from '../../../../application/offline-payment-envelope-service.ts';
export const POST: RouteHandler = context => offlineRequest(context, (user, body) =>
  issuePaymentEnvelope(user, z.object({ deviceId: z.string().uuid() }).strict().parse(body).deviceId));
