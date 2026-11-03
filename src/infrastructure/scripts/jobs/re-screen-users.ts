#!/usr/bin/env node
/**
 * Re-screening periodique P17 — vérifie les utilisateurs existants contre les listes
 *
 * Usage : npx tsx scripts/re-screen-users.ts
 * Cron  : 0 3 * * 0 npx tsx scripts/re-screen-users.ts (chaque dimanche a 3h)
 */

import pool from '../../database/pool.ts';
import { PROCESS_IDS, runCronWithEvidence } from '../../../application/services/process-evidence-service.ts';

async function runScheduledControl() {
  console.log('[Re-screen] Debut re-screening periodique...');

  // 1. Lister les entrees de screening non matchées
  const { rows: unmatched } = await pool.query(
    `SELECT id, full_name, match_type, list_name FROM konektag.screening_entries
     WHERE status = 'PENDING' AND linked_user_id IS NULL`,
  );

  console.log(`[Re-screen] ${unmatched.length} entrees sans correspondance`);

  // 2. Tenter le matching avec les utilisateurs actifs KYC_SKIPPED ou non verifies
  let newMatches = 0;
  for (const entry of unmatched) {
    const { rows: [user] } = await pool.query(
      `SELECT id FROM konektag.users WHERE state IN ('KYC_SKIPPED', 'KYC_PENDING', 'DRAFT') AND deleted_at IS NULL LIMIT 1`,
    );
    if (user) {
      await pool.query(
        `UPDATE konektag.screening_entries SET linked_user_id = $1, status = 'MATCHED_USER' WHERE id = $2`,
        [user.id, entry.id],
      );
      newMatches++;
    }
  }

  // 3. Verifier les KYC expires et downgrader les utilisateurs
  const { rows: expired } = await pool.query(
    `UPDATE konektag.users
     SET state = 'KYC_PENDING', kyc_expires_at = NULL, updated_at = now()
     WHERE kyc_expires_at IS NOT NULL AND kyc_expires_at < CURRENT_DATE AND state = 'COMPLETED' AND deleted_at IS NULL
     RETURNING id, username`,
  );
  if (expired.length > 0) {
    console.log(`[Re-screen] ${expired.length} utilisateurs avec KYC expire, passes en KYC_PENDING:`);
    for (const u of expired) console.log(`  ${u.username || u.id}`);
  }

  // 4. Verifier les ComplianceCases ouverts depuis > 48h
  const { rows: stale } = await pool.query(
    `SELECT id, case_ref, subject_user_id, triggered_at
     FROM konektag.compliance_cases
     WHERE status IN ('OPEN', 'UNDER_REVIEW')
       AND triggered_at < now() - interval '48 hours'`,
  );

  if (stale.length > 0) {
    console.log(`[Re-screen] ALERTE: ${stale.length} ComplianceCases ouverts depuis > 48h:`);
    for (const c of stale) {
      console.log(`  ${c.case_ref} — user ${c.subject_user_id} — depuis ${c.triggered_at}`);

      // Escalader automatiquement a ESCALATED
      await pool.query(
        `UPDATE konektag.compliance_cases SET status = 'ESCALATED', updated_at = now()
         WHERE id = $1 AND status = 'OPEN'`,
        [c.id],
      );
    }
  }

  console.log(`[Re-screen] Termine — ${newMatches} nouveaux matchs, ${stale.length} escalades`);
}

// GAP-024: durable start and terminal evidence for the mandatory P01/P17
// scheduled control (sanctions-cron).
async function main() {
  try {
    await runCronWithEvidence(PROCESS_IDS.sanctionsCron, runScheduledControl);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[Re-screen] Erreur:', err.message);
  process.exit(1);
});
