import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as issue } from '../../src/api/routes/wallet-authorizations/issue.ts';

describe('wallet authorization routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disables browser issuance of arbitrary Wallet operation snapshots', async () => {
    const request = new Request('https://app.example.test/api/wallet-authorizations/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.test' },
      body: JSON.stringify({
        operationType: 'transfer', operationId: 'transfer-1', amount: 1250, currency: 'XOF',
        payeeSnapshot: { displayName: 'Recipient' },
      }),
    });

    const response = await issue({ request, locals: { user: {
      id: 'user-1', keycloak_id: 'keycloak-1', username: 'payer', email: 'payer@example.test', locale: 'fr', state: 'COMPLETED',
    } } } as any);

    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body).toEqual({ error: 'ENDPOINT_DISABLED' });
  });
});
