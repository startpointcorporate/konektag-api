import pool from '../../../infrastructure/database/pool.ts';
import { ledgerService } from '../../services/ledger-service.ts';
import { exchangeRateService } from '../../services/exchange-rate-service.ts';
import { emailService } from '../../services/resend-service.ts';
import { encryptionService } from '../../../infrastructure/adapters/encryption-service.ts';
import { getCorrelationId } from '../../../infrastructure/correlation-id.ts';
import crypto from 'node:crypto';
import { activationChallengeService } from '../../services/activation-challenge-service.ts';

const MIN_BLOCKCHAIN_CONFIRMATIONS = 2;

export interface ConfirmCryptoInput {
  rechargeName: string;
  adminId: string;
  transactionHash: string;
  cryptoNetwork: string;
  confirmations: number;
  amountReceived: number;
  currency?: string;
  notes?: string;
}

export interface ConfirmCryptoResult {
  success: boolean;
  rechargeName: string;
  ledgerEntryId?: string;
  previousStatus?: string;
}

/**
 * Confirm a Crypto recharge.
 *
 * Transaction sequence (single PostgreSQL client, single transaction):
 *   1. BEGIN
 *   2. SELECT ... FOR UPDATE (lock projection row)
 *   3. Verify preconditions (pending, crypto, min confirmations, network match)
 *   4. INSERT INTO ledger_entries (credit, in XOF)
 *   5. INSERT INTO admin_actions (audit trace)
 *   6. INSERT INTO outbox_events (RechargeConfirmed)
 *   7. COMMIT
 *
 * Idempotent: verified via ledger entry check inside the same transaction.
 */
export async function confirmCryptoRecharge(input: ConfirmCryptoInput): Promise<ConfirmCryptoResult> {
  const { rechargeName, adminId, transactionHash, cryptoNetwork, confirmations, amountReceived, notes } = input;
  const correlationId = getCorrelationId() || crypto.randomUUID();

  if (confirmations < MIN_BLOCKCHAIN_CONFIRMATIONS) {
    const e = new Error(`Nombre de confirmations insuffisant : ${confirmations}. Minimum requis : ${MIN_BLOCKCHAIN_CONFIRMATIONS}.`) as any;
    e.statusCode = 400;
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL lock_timeout = 5000');

    // Lock the projection row inside the transaction
    const { rows: [proj] } = await client.query(
      `SELECT r.id, r.recharge_name, r.keycloak_id, r.requested_amount, r.requested_currency,
              r.recharge_status, r.credited_amount, r.payment_method, r.payment_provider,
               r.crypto_network, r.crypto_address, r.country,
              u.id AS user_id
       FROM konektag.recharge_projection r
       LEFT JOIN konektag.users u ON u.keycloak_id = r.keycloak_id
       WHERE r.recharge_name = $1 AND r.deleted_at IS NULL
       FOR UPDATE`,
      [rechargeName],
    );

    if (!proj) {
      const e = new Error('Recharge introuvable') as any;
      e.statusCode = 404;
      throw e;
    }

    if (proj.recharge_status !== 'pending') {
      const e = new Error(`La recharge ${rechargeName} est d\u00E9j\u00E0 "${proj.recharge_status}". Seules les recharges en attente peuvent \u00EAtre confirm\u00E9es.`) as any;
      e.statusCode = 409;
      throw e;
    }

    if (proj.payment_method !== 'crypto') {
      const e = new Error(`La recharge ${rechargeName} utilise "${proj.payment_method}", pas la cryptomonnaie.`) as any;
      e.statusCode = 400;
      throw e;
    }

    // Verify crypto network matches
    const expectedNetwork = proj.crypto_network || 'USDT_TRC20';
    if (cryptoNetwork !== expectedNetwork) {
      const e = new Error(`Le r\u00E9seau saisi "${cryptoNetwork}" ne correspond pas au r\u00E9seau attendu "${expectedNetwork}" pour cette recharge.`) as any;
      e.statusCode = 400;
      throw e;
    }

    // Idempotent check
    const { rows: existingCredit } = await client.query(
      `SELECT amount, currency FROM konektag.ledger_entries
       WHERE document_ref = $1
         AND entry_type = 'credit'
         AND document_type = 'Recharge'
         AND (is_reversal = false OR is_reversal IS NULL)
       LIMIT 1`,
      [rechargeName],
    );

    if (existingCredit.length > 0) {
      await client.query('COMMIT');
      return { success: true, rechargeName, previousStatus: 'pending' };
    }

    // Use the amount already frozen at recharge creation time
    const rechargeCurrency = proj.requested_currency || 'XOF';
    const rate = await exchangeRateService.getRate(rechargeCurrency, 'XOF');
    if (rate === null) {
      throw new Error(`Taux de change non disponible pour ${rechargeCurrency} → XOF`);
    }
    const amountXof = rechargeCurrency === 'XOF'
      ? Number(proj.requested_amount)
      : Math.round(Number(proj.requested_amount) * rate);

    // Credit the ledger (using the transaction client)
    await ledgerService.credit({
      clientId: proj.keycloak_id,
      amount: amountXof,
      currency: 'XOF',
      documentType: 'Recharge',
      documentRef: rechargeName,
      description: `Rechargement Crypto — ${amountReceived} ${rechargeCurrency} (${cryptoNetwork})${notes ? ' · ' + notes : ''}`,
    }, client);

    // Admin action
    await client.query(
      `INSERT INTO konektag.admin_actions
       (admin_id, action_type, target_type, target_id, reason, payload)
       VALUES ($1, 'RECHARGE_CONFIRM', 'recharge', $2, $3, $4)`,
      [
        adminId,
        rechargeName,
        notes || `Confirmation Crypto — tx: ${transactionHash.slice(0, 16)}...`,
        JSON.stringify({
          rechargeName,
          transactionHash,
          cryptoNetwork,
          confirmations,
          amountReceived,
          rechargeCurrency,
          amountXof,
          correlationId,
        }),
      ],
    );

    // Outbox event for projection
    const { rows: [evt] } = await client.query(
       `INSERT INTO konektag.outbox_events
        (correlation_id, causation_id, aggregate_type, aggregate_id, aggregate_ref, event_type, event_version, payload)
        VALUES ($1, $2, 'Recharge', gen_random_uuid(), $3, 'RechargeConfirmed', 1, $4)
       RETURNING id`,
      [
        correlationId,
        correlationId,
        rechargeName,
        JSON.stringify({
          rechargeName,
          creditedAmount: amountXof,
          creditedCurrency: 'XOF',
          providerReference: transactionHash,
          providerStatus: 'completed',
          ledgerDocumentRef: rechargeName,
          sourceOperationId: `admin-confirm-crypto-${rechargeName}`,
          correlationId,
          causationId: correlationId,
        }),
      ],
    );

    await client.query('COMMIT');

    if (proj.user_id) {
      await activationChallengeService.recordActivity({
        userId: proj.user_id,
        sourceType: 'recharge',
        sourceId: rechargeName,
        metricType: 'Deposit',
        amount: Number(proj.requested_amount),
        currency: String(rechargeCurrency).toUpperCase(),
        countryCode: proj.country,
        metadata: { cryptoNetwork, transactionHash },
      }).catch(error => console.error(`[activation] Crypto recharge projection failed for ${rechargeName}:`, error.message));
    }

    // Notify (fire-and-forget)
    notifyUser(proj.keycloak_id, amountReceived, rechargeCurrency, rechargeName, cryptoNetwork).catch(err =>
      console.error(`[confirm-crypto] Notification failed for ${rechargeName}:`, err.message),
    );

    return { success: true, rechargeName, ledgerEntryId: evt?.id || undefined };

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function notifyUser(keycloakId: string, amount: number, currency: string, rechargeName: string, network: string): Promise<void> {
  const { rows: [u] } = await pool.query(
    `SELECT encrypted_data, locale FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
    [keycloakId],
  );
  if (!u) return;

  const decrypted = JSON.parse(encryptionService.decrypt(u.encrypted_data));
  if (!decrypted.email) return;

  await emailService.sendTemplate('refillAccount', u.locale || 'fr', decrypted.email, {
    firstName: decrypted.firstName || '',
    amount: amount.toString(),
    currency,
    transactionDate: new Date().toLocaleDateString('fr-FR'),
    transactionReference: rechargeName,
    paymentMethod: `Crypto (${network})`,
    newBalance: 'Cf. dashboard',
    currentYear: new Date().getFullYear().toString(),
  });
}
