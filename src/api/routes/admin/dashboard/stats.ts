import type { RouteHandler } from '../../../http';
import pool from '../../../../infrastructure/database/pool.ts';
import { getOutboxMetrics } from '../../../../application/outbox-dispatcher.ts';

async function adminGuard(locals: any) {
  const user = (locals as any).user;
  if (!user) return null;
  const { rows: [u] } = await pool.query(`SELECT role FROM konektag.users WHERE id = $1`, [user.id]);
  if (!u || u.role !== 'admin') return null;
  return user;
}

export const GET: RouteHandler = async ({ locals }) => {
  if (!await adminGuard(locals)) {
    return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
  }

  try {
    // ── Volume KPIs ──
    const { rows: [volume] } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_recharges,
        COALESCE(SUM(requested_amount), 0)::bigint AS total_volume,
        COUNT(*) FILTER (WHERE recharge_status = 'pending')::int AS pending_count,
        COUNT(*) FILTER (WHERE recharge_status = 'confirmed')::int AS confirmed_count,
        COUNT(*) FILTER (WHERE recharge_status = 'reversed')::int AS reversed_count,
        COUNT(*) FILTER (WHERE recharge_status = 'failed')::int AS failed_count,
        COUNT(*) FILTER (WHERE anomaly IS NOT NULL)::int AS anomaly_count,
        COUNT(*) FILTER (WHERE credited_amount IS NULL AND recharge_status != 'pending')::int AS missing_credit_count
      FROM konektag.recharge_projection
      WHERE deleted_at IS NULL
    `);

    // ── By payment method ──
    const { rows: byMethod } = await pool.query(`
      SELECT payment_method, COUNT(*)::int AS count, COALESCE(SUM(requested_amount), 0)::bigint AS volume
      FROM konektag.recharge_projection
      WHERE deleted_at IS NULL
      GROUP BY payment_method
      ORDER BY count DESC
    `);

    // ── Today's activity ──
    const { rows: [today] } = await pool.query(`
      SELECT
        COUNT(*)::int AS today_count,
        COALESCE(SUM(requested_amount), 0)::bigint AS today_volume,
        COUNT(*) FILTER (WHERE recharge_status = 'confirmed')::int AS today_confirmed
      FROM konektag.recharge_projection
      WHERE deleted_at IS NULL AND created_at >= CURRENT_DATE
    `);

    // ── Outbox queues ──
    const { rows: [outboxStats] } = await pool.query(`
      SELECT
        COUNT(*)::int AS pending_events,
        COUNT(*) FILTER (WHERE blocked_reason IS NOT NULL)::int AS blocked_events,
        COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered_count,
        ROUND(EXTRACT(EPOCH FROM (now() - MIN(created_at))))::int AS oldest_pending_age_seconds
      FROM konektag.outbox_events
      WHERE processed_at IS NULL
    `);

    // ── Dead letters unresolved ──
    const { rows: [deadLetters] } = await pool.query(`
      SELECT COUNT(*)::int AS unresolved_dead_letters
      FROM konektag.outbox_dead_letters
      WHERE resolved_at IS NULL
    `);

    // ── Reconciliation required ──
    const { rows: [reconciliation] } = await pool.query(`
      SELECT COUNT(*)::int AS reconciliation_required
      FROM konektag.integration_operations
      WHERE status = 'reconciliation_required'
    `);

    // ── Integration operations in error ──
    const { rows: [integrations] } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_failed,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        COUNT(*) FILTER (WHERE status = 'reconciliation_required')::int AS reconciliation_count
      FROM konektag.integration_operations
      WHERE status IN ('failed', 'reconciliation_required')
    `);

    // ── Outbox dispatcher in-memory metrics ──
    const outboxMetrics = getOutboxMetrics();

    // ── Recent activity timeline ──
    const { rows: recentEvents } = await pool.query(`
      SELECT
        e.event_type, e.aggregate_ref, e.created_at,
        e.payload->>'reason' AS reason
      FROM konektag.outbox_events e
      WHERE e.event_type LIKE 'Recharge%'
      ORDER BY e.created_at DESC
      LIMIT 20
    `);

    return new Response(JSON.stringify({
      kpis: {
        totalRecharges: volume?.total_recharges || 0,
        totalVolume: volume?.total_volume || 0,
        pendingCount: volume?.pending_count || 0,
        confirmedCount: volume?.confirmed_count || 0,
        reversedCount: volume?.reversed_count || 0,
        failedCount: volume?.failed_count || 0,
        anomalyCount: volume?.anomaly_count || 0,
        missingCreditCount: volume?.missing_credit_count || 0,
      },
      byMethod: byMethod.map((m: any) => ({
        method: m.payment_method,
        count: m.count,
        volume: m.volume,
      })),
      today: {
        count: today?.today_count || 0,
        volume: today?.today_volume || 0,
        confirmed: today?.today_confirmed || 0,
      },
      queues: {
        pendingEvents: outboxStats?.pending_events || 0,
        blockedEvents: outboxStats?.blocked_events || 0,
        deadLetteredCount: outboxStats?.dead_lettered_count || 0,
        oldestPendingAgeSeconds: outboxStats?.oldest_pending_age_seconds || 0,
      },
      outboxMetrics: {
        retryCount: outboxMetrics.retryCount,
        deadLetterCount: outboxMetrics.deadLetterCount,
        blockedCount: outboxMetrics.blockedCount,
        meanProjectionTime: outboxMetrics.meanProjectionTime,
        maxProjectionTime: outboxMetrics.maxProjectionTime,
        projectionFailuresPerMinute: outboxMetrics.projectionFailuresPerMinute,
      },
      deadLetters: {
        unresolved: deadLetters?.unresolved_dead_letters || 0,
      },
      reconciliation: {
        required: reconciliation?.reconciliation_required || 0,
      },
      integrations: {
        totalFailed: integrations?.total_failed || 0,
        failedCount: integrations?.failed_count || 0,
        reconciliationCount: integrations?.reconciliation_count || 0,
      },
      recentEvents: recentEvents.map((e: any) => ({
        type: e.event_type,
        aggregateRef: e.aggregate_ref,
        createdAt: e.created_at,
        reason: e.reason,
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('[admin/dashboard/stats]', err);
    return new Response(JSON.stringify({ error: 'SERVER_ERROR' }), { status: 500 });
  }
};
