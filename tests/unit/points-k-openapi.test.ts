import { describe, expect, it } from 'vitest';
// The documentation generator is intentionally plain ESM and runs directly under Node.
// @ts-expect-error no declaration file is needed for this build-time helper
import { documentPointsKWebContracts } from '../../src/infrastructure/scripts/points-k-openapi.mjs';

const operation = () => ({ parameters: [], responses: { '200': { content: {} }, '201': { content: {} } }, requestBody: { content: { 'application/json': { schema: {} } } } });

describe('Points K web OpenAPI contracts', () => {
  it('documents server-routed recharge and K_SEND without changing Link Pay', () => {
    const paths: any = {
      '/api/pay/recharges': { post: operation() }, '/api/k/send/quote': { post: operation() },
      '/api/k/send': { post: operation() }, '/api/k/send/{id}': { post: operation() }, '/api/k/send/recipient': { post: operation() },
    };
    documentPointsKWebContracts(paths);
    expect(paths['/api/pay/recharges'].post.requestBody.content['application/json'].schema.properties.amount.description).toContain('mineure');
    expect(paths['/api/pay/recharges'].post.requestBody.content['application/json'].schema.required).toEqual(['amount', 'currency']);
    expect(paths['/api/pay/recharges'].post.description).toContain('résolus côté serveur');
    expect(paths['/api/k/send/{id}'].post.requestBody.content['application/json'].schema.properties.otp.pattern).toBe('^\\d{6}$');
    expect(paths['/api/k/send'].post.description).toContain('pas un achat-cadeau');
    expect(Object.keys(paths['/api/pay/recharges'].post.responses)).toEqual(expect.arrayContaining(['400', '404', '409', '422', '503']));
    expect(paths['/api/pay/recharges'].post.responses['409'].description).toContain('CHECKOUT_ALREADY_EXISTS');
    expect(paths['/api/k/send/{id}'].post.responses['202'].description).toContain('OTP');
    expect(paths['/api/k/send/recipient'].post.requestBody.content['application/json'].schema.required).toEqual(['recipientUserId', 'fullName']);
  });
});
