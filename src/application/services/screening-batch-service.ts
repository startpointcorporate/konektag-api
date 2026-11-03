import pool from '../../infrastructure/database/pool.ts';

export interface ScreeningBatchInput {
  batchRef: string;
  source: string;
  sourceDate: string;
  entries: Array<{
    entryRef: string;
    fullName: string;
    matchType: 'sanction' | 'pep' | 'ubo' | 'country_risk' | 'adverse_media';
    listName?: string;
    matchScore?: number;
    rawData?: Record<string, unknown>;
    /** Optionnel : email/phone pour tentative de matching automatique */
    identityHint?: string;
  }>;
}

export interface ScreeningBatchResult {
  batchId: string;
  totalEntries: number;
  matchedUsers: number;
  casesCreated: number;
  noMatch: number;
}

export const screeningBatchService = {
  async importBatch(input: ScreeningBatchInput, adminUserId: string): Promise<ScreeningBatchResult> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [batch] } = await client.query(
        `INSERT INTO konektag.screening_batches (batch_ref, source, source_date, total_entries)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.batchRef, input.source, input.sourceDate, input.entries.length],
      );

      let matchedUsers = 0;
      let casesCreated = 0;
      let noMatch = 0;

      for (const entry of input.entries) {
        const { rows: [screened] } = await client.query(
          `INSERT INTO konektag.screening_entries (batch_id, entry_ref, full_name, match_type, list_name, match_score, raw_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [batch.id, entry.entryRef, entry.fullName, entry.matchType,
           entry.listName, entry.matchScore, JSON.stringify(entry.rawData || {})],
        );

        let linkedUserId: string | null = null;

        if (entry.identityHint) {
          const { rows: [matched] } = await client.query(
            `SELECT id FROM konektag.users
             WHERE (email_hash = encode(sha256($1::bytea), 'hex') OR phone_hash = encode(sha256($2::bytea), 'hex'))
               AND deleted_at IS NULL LIMIT 1`,
            [entry.identityHint, entry.identityHint],
          );
          if (matched) linkedUserId = matched.id;
        }

        if (linkedUserId) {
          const { rows: [cc] } = await client.query(
            `INSERT INTO konektag.compliance_cases (case_ref, case_type, severity, subject_user_id, triggered_by, status, notes)
             VALUES ($1, $2, 'high', $3, $4, 'OPEN', $5) RETURNING id`,
            [`SCREEN-${input.batchRef}-${entry.entryRef}`.substring(0, 50),
             `${entry.matchType}_hit`, linkedUserId, 'screening_batch',
             `Detection automatique batch ${input.batchRef} : ${entry.fullName} (${entry.matchType})`],
          );

          await client.query(
            `UPDATE konektag.screening_entries
             SET linked_user_id = $1, compliance_case_id = $2, status = 'CASE_CREATED'
             WHERE id = $3`,
            [linkedUserId, cc.id, screened.id],
          );
          casesCreated++;
          matchedUsers++;
        } else {
          noMatch++;
        }
      }

      await client.query(
        `UPDATE konektag.screening_batches SET positive_hits = $1, status = 'PROCESSED', processed_at = now()
         WHERE id = $2`,
        [casesCreated, batch.id],
      );

      await client.query('COMMIT');
      return { batchId: batch.id, totalEntries: input.entries.length, matchedUsers, casesCreated, noMatch };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async listBatches(limit = 20, offset = 0): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT * FROM konektag.screening_batches ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows;
  },

  async getBatchEntries(batchId: string): Promise<any[]> {
    const { rows } = await pool.query(
      `SELECT * FROM konektag.screening_entries WHERE batch_id = $1 ORDER BY created_at`,
      [batchId],
    );
    return rows;
  },
};
