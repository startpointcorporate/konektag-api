import { z } from 'zod';

export const PointsKValuationSchema = z.object({
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
  sourceAmountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  rate: z.string().regex(/^\d+(\.\d+)?$/),
  eurAmountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  quantityK: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  matrixVersion: z.number().int().positive(),
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }),
  authorityId: z.string().uuid(),
  approvalSource: z.string().min(1).max(160),
  proofHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type PointsKValuation = z.infer<typeof PointsKValuationSchema>;
