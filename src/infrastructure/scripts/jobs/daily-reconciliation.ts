#!/usr/bin/env node
/**
 * Rapprochement quotidien P16 — GL Utilisateur, GL FTG-FR, GL KTG-CG, rails
 *
 * Usage : npx tsx scripts/daily-reconciliation.ts [YYYY-MM-DD]
 * Cron  : 0 2 * * * npx tsx scripts/daily-reconciliation.ts
 */

import pool from '../../database/pool.ts';
import { ReconciliationService } from '../../../application/services/reconciliation-service.ts';
import { runDailyReconciliation, type DailyReconciliationContext } from '../../../application/services/daily-reconciliation-service.ts';
import { PROCESS_IDS, runCronWithEvidence } from '../../../application/services/process-evidence-service.ts';

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const reconciliation = new ReconciliationService();
  console.log(`[Reconciliation] Date: ${date}`);

  // GAP-024: durable start and terminal evidence around the corrected P16
  // execution. The reconciliation equations themselves are untouched.
  await runCronWithEvidence(PROCESS_IDS.reconciliationCron, async () => {
    const client = await pool.connect();
    try {
      const { rows: [context] } = await client.query<DailyReconciliationContext>(
        `SELECT france.id AS "franceLegalEntityId", congo.id AS "congoLegalEntityId",
                (SELECT sale.currency FROM konektag.merchant_sales sale
                  WHERE sale.legal_entity_id = france.id AND sale.deleted_at IS NULL
                  ORDER BY sale.created_at DESC LIMIT 1) AS currency
           FROM konektag.legal_entities france
           JOIN konektag.legal_entities congo ON congo.code = 'KTG-CG' AND congo.deleted_at IS NULL AND congo.status = 'APPROVED'
          WHERE france.code = 'KTG-FR' AND france.deleted_at IS NULL AND france.status = 'APPROVED'`,
      );
      if (!context?.franceLegalEntityId || !context.congoLegalEntityId || !context.currency) throw new Error('RECONCILIATION_CONTEXT_MISSING');
      const results = await runDailyReconciliation(client, reconciliation, date, context);
      for (const { control, result } of results) console.log(`  ${control}: ${result.status}`);
    } finally {
      client.release();
    }
  });

  console.log('[Reconciliation] Termine');
  await pool.end();
}

main().catch(err => {
  console.error('[Reconciliation] Erreur:', err.message);
  process.exit(1);
});
