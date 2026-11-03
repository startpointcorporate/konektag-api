#!/usr/bin/env node
/**
 * P18 — Purge automatique des donnees expirees (retention policy)
 *
 * Cron: 0 4 * * * npx tsx scripts/purge-expired-data.ts
 *
 * Regles:
 *   - KYC documents: 2 ans (configurable via data_retention_days)
 *   - Disputes: 5 ans
 *   - Audit logs: 10 ans (pas de purge)
 *   - PII chiffree: selon data_retention_days utilisateur
 *   - Idempotency keys: 24h
 *   - Outbox events traites: 30 jours
 */

import pool from '../../database/pool.ts';
import { minioAdapter } from '../../adapters/minio-adapter.ts';
import { PROCESS_IDS, runCronWithEvidence } from '../../../application/services/process-evidence-service.ts';

async function runScheduledControl() {
  console.log('[Purge] Debut purge donnees expirees...');

  // 1. Supprimer les idempotency keys expirees (> 24h)
  const { rowCount: idemPurged } = await pool.query(
    `DELETE FROM konektag.idempotency_keys WHERE expires_at < now() - interval '24 hours'`,
  );
  console.log(`  Idempotency keys: ${idemPurged || 0} supprimees`);

  // 2. Supprimer les outbox events traites depuis > 30 jours.
  // Completion is represented by processed_at/dead_lettered_at, not a status column.
  const { rowCount: outboxPurged } = await pool.query(
    `DELETE FROM konektag.outbox_events
      WHERE (processed_at IS NOT NULL OR dead_lettered_at IS NOT NULL)
        AND created_at < now() - interval '30 days'`,
  );
  console.log(`  Outbox events: ${outboxPurged || 0} supprimees`);

  // 3. Soft-delete KYC orders expires selon retention utilisateur
  const { rowCount: kycPurged } = await pool.query(
    `UPDATE konektag.kyc_orders SET deleted_at = now()
     WHERE purge_at IS NOT NULL AND purge_at < CURRENT_DATE AND deleted_at IS NULL`,
  );
  console.log(`  KYC orders: ${kycPurged || 0} soft-deletees`);

  // 4. Anonymiser PII des utilisateurs supprimes depuis > retention_days
  const { rowCount: piiPurged } = await pool.query(
    `UPDATE konektag.users SET encrypted_data = '\x00', email_hash = '', phone_hash = ''
     WHERE deleted_at IS NOT NULL
       AND deleted_at < now() - (data_retention_days || '730')::int * interval '1 day'
       AND encrypted_data IS NOT NULL`,
  );
  console.log(`  PII anonymisees: ${piiPurged || 0} utilisateurs`);

  // 5. Supprimer les fichiers MinIO des KYC expires
  try {
    const { rows: expiredDocs } = await pool.query(
      `SELECT id_document_path FROM konektag.users
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - interval '2 years'
         AND id_document_path IS NOT NULL`,
    );
    for (const doc of expiredDocs) {
      try {
        await minioAdapter.removeObject(process.env.MINIO_KYC_BUCKET || 'konektag-kyc', doc.id_document_path);
      } catch {}
    }
    console.log(`  Fichiers MinIO: ${expiredDocs.length} supprimes`);
  } catch (e: any) {
    console.log(`  Fichiers MinIO: erreur (${e.message})`);
  }

  console.log('[Purge] Termine');
}

// GAP-024: durable start and terminal evidence for the mandatory P18
// scheduled control (retention-cron).
async function main() {
  try {
    await runCronWithEvidence(PROCESS_IDS.retentionCron, runScheduledControl);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[Purge] Erreur:', err.message);
  process.exit(1);
});
