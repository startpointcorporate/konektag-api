import { describe, expect, it } from 'vitest';
// The documentation generator is intentionally plain ESM and runs directly under Node.
// @ts-expect-error no declaration file is needed for this build-time helper
import { documentPointsKWebContracts } from '../../src/infrastructure/scripts/points-k-openapi.mjs';

const operation = () => ({ parameters: [], responses: { '200': { content: {} }, '201': { content: {} } }, requestBody: { content: { 'application/json': { schema: {} } } } });

describe('Points K web OpenAPI contracts', () => {
  it('publishes Link Pay, recharge minor units and K_SEND OTP without inventing gift purchase', () => {
    const paths: any = {
      '/api/pay/payment-links': { get: operation() }, '/api/pay/payment-links/{slug}/resume': { post: operation() },
      '/api/pay/pay-link': { post: operation() }, '/api/pay/recharges': { post: operation() },
      '/api/k/send/quote': { post: operation() }, '/api/k/send': { post: operation() }, '/api/k/send/{id}': { post: operation() },
    };
    documentPointsKWebContracts(paths);
    expect(paths['/api/pay/payment-links'].get.responses['200'].content['application/json'].schema.properties.links.items.properties.status.enum)
      .toEqual(['Active', 'Expired', 'Used']);
    expect(paths['/api/pay/recharges'].post.requestBody.content['application/json'].schema.properties.amount.description).toContain('mineure');
    expect(paths['/api/pay/recharges'].post.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
    expect(paths['/api/k/send/{id}'].post.requestBody.content['application/json'].schema.properties.otp.pattern).toBe('^\\d{6}$');
    expect(paths['/api/k/send'].post.description).toContain('pas un achat-cadeau');
  });
});
