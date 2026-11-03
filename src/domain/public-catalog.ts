import { z } from 'zod';
const text = z.string().trim().max(2000).optional();
const httpUrl = z.string().url().max(2000).refine(v => /^https?:\/\//.test(v), 'HTTP(S) required');
export const CatalogMetadataSchema = z.object({
  type: z.enum(['product', 'service']).optional(), sku: text, shortDescription: text,
  detailedDescription: z.string().max(20000).optional(), subcategory: text,
  tags: z.array(z.string().max(100)).max(50).optional(), unit: text,
  status: z.enum(['active','draft','archived']).optional(), visibility: z.enum(['public','private']).optional(),
  availability: text, slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(150).optional(),
  seoTitle: z.string().max(200).optional(), seoDescription: text, brand: text,
  variants: z.array(z.string().max(500)).max(100).optional(), stock: z.number().int().nonnegative().optional(),
  weight: text, dimensions: text, duration: text, capacity: z.number().int().nonnegative().optional(),
  bookingRequired: z.boolean().optional(), fulfillment: text,
  mediaIds: z.array(z.string().uuid()).max(30).optional(),
  links: z.array(z.object({label: z.string().max(200), url: httpUrl}).strict()).max(30).optional(),
}).strict();
export type CatalogMetadata = z.infer<typeof CatalogMetadataSchema>;
export const ReelSchema = z.object({
  id: z.string().uuid().optional(), merchantProfileId: z.string().uuid(),
  article: z.string().trim().min(1).max(20000), mediaIds: z.array(z.string().uuid()).min(1).max(30),
  destination: z.enum(['profile','catalog','product']), productId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime(), endsAt: z.string().datetime(),
}).strict().refine(v => Date.parse(v.startsAt) < Date.parse(v.endsAt), 'Invalid display period')
.refine(v => v.destination === 'product' ? !!v.productId : !v.productId, 'Invalid product destination');
export function catalogPath(merchantId: string, productId?: string, locale = 'fr') {
  return `/${encodeURIComponent(locale)}/catalog/${encodeURIComponent(merchantId)}/${productId ? encodeURIComponent(productId) + '/' : ''}`;
}
export function isPublicProduct(metadata: CatalogMetadata = {}) {
  return (!metadata.status || metadata.status === 'active') && (!metadata.visibility || metadata.visibility === 'public');
}
export function visibleMetadata(metadata: CatalogMetadata) {
  return Object.entries(metadata).filter(([key, value]) => !['mediaIds','links'].includes(key) && value !== '' && value !== null && value !== undefined && (!Array.isArray(value) || value.length));
}
export const CartSchema = z.object({merchantProfileId: z.string().uuid(), lines: z.array(z.object({
  offerId: z.string().uuid(), pricingRuleId: z.string().uuid(), quantity: z.number().int().positive().max(2147483647),
}).strict()).min(1).max(100)}).strict();
export function addCartLine(cart: {merchantProfileId: string; lines: any[]} | null, merchantProfileId: string, line: {offerId: string; pricingRuleId: string; quantity: number}) {
  if (cart && cart.lines.length && cart.merchantProfileId !== merchantProfileId) throw new Error('CART_MERCHANT_CONFLICT');
  const lines = (cart?.merchantProfileId === merchantProfileId ? cart.lines : []).map(x => ({...x}));
  const existing = lines.find(x => x.offerId === line.offerId && x.pricingRuleId === line.pricingRuleId);
  if (existing) existing.quantity += line.quantity; else lines.push(line);
  return CartSchema.parse({merchantProfileId, lines});
}
