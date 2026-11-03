import { describe, expect, it } from 'vitest';
import { parseMobileMoneyConfirmation } from '../../src/application/commands/admin/mobile-money-confirmation.ts';

describe('P03 manual Mobile Money input', () => {
  const valid = { provider: 'mtn', country: 'cg', operator: 'mtn', providerReference: 'CG-100', amount: 5000, currency: 'xof', receivedAt: '2026-07-20T10:00:00.000Z', maskedSender: '******1234', evidenceRef: 'minio://konektag-evidence/CG-100.pdf' };

  it('normalizes the regulated receipt fields', () => {
    expect(parseMobileMoneyConfirmation(valid)).toMatchObject({ provider: 'MTN', country: 'CG', currency: 'XOF', amount: 5000 });
  });

  it('rejects a receipt that exposes a full sender number', () => {
    expect(() => parseMobileMoneyConfirmation({ ...valid, maskedSender: '242061234567' })).toThrow('maskedSender');
  });
});
