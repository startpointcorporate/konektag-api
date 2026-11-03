import { beforeEach, expect, it, vi } from 'vitest';
import { formatMinor } from '../../src/application/services/pay/money-unit.ts';
const mocks = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({ default: { query: mocks.query } }));
vi.mock('../../src/application/services/resend-service.ts', () => ({ emailService: { send: mocks.send } }));
import { linkPaymentReceiptHtml, sendLinkPaymentReceipt } from '../../src/application/services/link-payment-receipt-service.ts';
const payment = { merchantName: 'Marchand <Test>', amount: 35000, currency: 'XAF', quantityK: 53, reference: 'LINK-42' };
const input = { email: 'receipt@example.test', slug: 'abc', userId: 'payer', payment, origin: 'https://konektag.test' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [{ consumed_at: '2026-10-03T10:15:20Z' }] });
  mocks.send.mockResolvedValue(true);
});
it('T03 includes merchant, formatted amount, K, reference, payment date, paid status and history', () => {
  const html = linkPaymentReceiptHtml(payment, '2026-10-03T10:15:20Z', 'https://konektag.test/fr/account/history/', 'Ada <Test>');
  for (const text of ['Bonjour Ada &lt;Test&gt;', 'Paiement confirmé', 'Marchand &lt;Test&gt;', '35 000 XAF', '53 K',
    'LINK-42', '3 octobre 2026', 'Payé', 'Voir mon historique', 'https://konektag.test/fr/account/history/']) expect(html).toContain(text);
  expect(html).not.toContain('Ada <Test>');
  expect(html).not.toContain('confirmer le paiement');
  expect(linkPaymentReceiptHtml(payment, '2026-10-03T10:15:20Z', input.origin)).toContain('<p>Bonjour,</p>');
});
it('T04 reuses the minor-unit formatter for XAF and decimal EUR', () => {
  expect(formatMinor(35000, 'XAF')).toBe('35 000');
  expect(formatMinor(350012, 'EUR')).toBe('3 500,12');
  expect(linkPaymentReceiptHtml({ ...payment, amount: 350012, currency: 'EUR' }, '2026-10-03T10:15:20Z', input.origin)).toContain('3 500,12 EUR');
});
it('uses the recorded consumed_at and scopes the read to the paid Link owner', async () => {
  expect(await sendLinkPaymentReceipt(input)).toBe(true);
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status='CONSUMED'"), ['abc', 'payer']);
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Confirmation de paiement — Konektag', to: input.email }));
});
it('does not read or send without an optional address', async () => {
  expect(await sendLinkPaymentReceipt({ ...input, email: undefined })).toBe(false);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it('does not invent a date when the payment timestamp cannot be read', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] });
  expect(await sendLinkPaymentReceipt(input)).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
});
it('contains provider and receipt-read failures after payment', async () => {
  mocks.send.mockRejectedValueOnce(new Error('EMAIL_DOWN'));
  expect(await sendLinkPaymentReceipt(input)).toBe(false);
  mocks.query.mockRejectedValueOnce(new Error('READ_DOWN'));
  expect(await sendLinkPaymentReceipt(input)).toBe(false);
});
