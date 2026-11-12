import { createHash } from 'node:crypto';
import { assertPawaPayFinancialOperation, PawaPaySandboxPolicyError } from '../../../infrastructure/adapters/pawapay-sandbox-policy.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { pawaPayClient, type PawaPayDeposit } from '../../../infrastructure/adapters/pawapay-client.ts';
import { apiPaymentCheckoutService } from './api-payment-checkout-service.ts';
import { paymentProviderAttemptService } from './payment-provider-attempt-service.ts';

export const pawaPayDepositService = {
  async consume(deposit: PawaPayDeposit, rawPayload: string): Promise<void> {
    assertPawaPayFinancialOperation(await paymentProviderAttemptService.getPawaPayConfigurationKey(deposit.depositId));
    await paymentProviderAttemptService.markPawaPayDepositObserved(deposit.depositId);
    const event = await paymentProviderAttemptService.consumePawaPayDeposit(deposit, createHash('sha256').update(rawPayload).digest('hex'));
    if (event.outcome === 'failed') {
      console.log('[pawapay] payment failed; reopening checkout', {
        depositId: deposit.depositId,
        orderId: event.sourceId,
        failureReason: deposit.failureReason ?? null,
      });
      await apiPaymentCheckoutService.handleProviderAttemptFailure(event.sourceId, deposit.depositId);
    }
    if (event.outcome === 'ready_to_settle') { await apiPaymentCheckoutService.markFinalAndDispatch(event.sourceId, 'mobile_money', deposit.depositId, event.eventId); await paymentProviderAttemptService.markPawaPayEventProcessed(event.eventId); }
  },
  async reconcile(batchSize = 50): Promise<number> {
    // Recover orders left awaiting Mobile Money after PawaPay had already
    // reached FAILED (for example if failure propagation crashed or was deployed
    // after the provider event was processed). This is idempotent: the handler
    // only reopens a non-terminal order whose referenced attempt is terminal.
    const staleFailures = await pool.query<{order_id:string;provider_reference:string}>(`
      SELECT o.id AS order_id,a.provider_reference
      FROM konektag.api_payment_orders o
      JOIN konektag.payment_provider_attempts a
        ON a.source_type='api_payment' AND a.source_id::text=o.id::text
      WHERE a.provider='pawapay' AND a.state='failed'
        AND o.state IN ('processing','awaiting_mobile_money')
        AND o.funding_state='external_started'
      ORDER BY a.updated_at
      LIMIT $1`, [batchSize]);
    for (const failure of staleFailures.rows) {
      try { assertPawaPayFinancialOperation(await paymentProviderAttemptService.getPawaPayConfigurationKey(failure.provider_reference)); }
      catch (error) { if (error instanceof PawaPaySandboxPolicyError) continue; throw error; }
      console.log('[pawapay-reconciliation] recovering failed checkout', {
        orderId: failure.order_id, depositId: failure.provider_reference,
      });
      await apiPaymentCheckoutService.handleProviderAttemptFailure(
        failure.order_id, failure.provider_reference);
    }

    const client = await pool.connect();
    let rows: Array<{ provider_reference:string }>;
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(
        `SELECT provider_reference FROM konektag.payment_provider_attempts
         WHERE provider='pawapay' AND state IN ('pending','processing')
         ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT $1`, [batchSize]));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined); throw error;
    } finally { client.release(); }

    for (const { provider_reference: depositId } of rows) {
      const startedAt = Date.now();
      console.log('[pawapay-reconciliation] deposit poll start', { depositId });
      try {
        const key = await paymentProviderAttemptService.getPawaPayConfigurationKey(depositId);
        const deposit = await pawaPayClient.getDeposit(depositId, key);
        console.log('[pawapay-reconciliation] deposit poll result', {
          depositId, status: deposit.status, durationMs: Date.now()-startedAt,
        });
        await this.consume(deposit, JSON.stringify(deposit));
      } catch (error) {
        const message=(error as Error).message;
        if (message === 'PawaPay deposit NOT_FOUND') {
          console.log('[pawapay-reconciliation] deposit not created yet', {
            depositId,durationMs:Date.now()-startedAt,
          });
        } else {
          console.error('[pawapay-reconciliation] deposit poll failed', {
            depositId,durationMs:Date.now()-startedAt,error:message,
          });
        }
      }
    }
    return rows.length;
  },
  activeConfiguration() { return pawaPayClient.activeConfiguration(); },
};
