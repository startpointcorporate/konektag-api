import pool from '../../infrastructure/database/pool.ts';

const BATCH_TRANSITIONS: Record<string, string[]> = {
  MANUFACTURED: ['DISTRIBUTED', 'CANCELLED', 'BLOCKED'], DISTRIBUTED: ['CANCELLED', 'BLOCKED'],
};

export const cardLifecycleService = {
  async transitionBatch(input: { batchId: string; action: 'DISTRIBUTE' | 'CANCEL' | 'BLOCK'; actorId: string; reason: string }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [batch] } = await client.query(`SELECT * FROM konektag.card_batches WHERE id = $1 FOR UPDATE`, [input.batchId]);
      if (!batch) throw new Error('CARD_BATCH_NOT_FOUND');
      const next = input.action === 'DISTRIBUTE' ? 'DISTRIBUTED' : input.action === 'CANCEL' ? 'CANCELLED' : 'BLOCKED';
      if (!BATCH_TRANSITIONS[batch.lifecycle_status]?.includes(next)) throw new Error('INVALID_CARD_BATCH_TRANSITION');
      await client.query(
        `UPDATE konektag.card_batches SET lifecycle_status=$1, lifecycle_reason=$2, distributed_at=CASE WHEN $1='DISTRIBUTED' THEN now() ELSE distributed_at END,
         cancelled_at=CASE WHEN $1='CANCELLED' THEN now() ELSE cancelled_at END, blocked_at=CASE WHEN $1='BLOCKED' THEN now() ELSE blocked_at END, version=version+1 WHERE id=$3`,
        [next, input.reason, input.batchId],
      );
      if (next === 'DISTRIBUTED') await client.query(`UPDATE konektag.cards SET status='DISTRIBUTED', version=version+1 WHERE batch_id=$1 AND status='GENERATED' AND deleted_at IS NULL`, [input.batchId]);
      if (next !== 'DISTRIBUTED') await client.query(
        `UPDATE konektag.cards SET status=$1, lifecycle_reason=$2, ${next === 'BLOCKED' ? 'blocked_at' : 'cancelled_at'}=now(), version=version+1
         WHERE batch_id=$3 AND status IN ('GENERATED','DISTRIBUTED') AND deleted_at IS NULL`, [next, input.reason, input.batchId],
      );
      await client.query(
        `INSERT INTO konektag.admin_actions (admin_id, action_type, target_type, target_id, reason, payload)
         VALUES ($1,$2,'card_batch',$3,$4,$5)`,
        [input.actorId, `CARD_BATCH_${input.action}`, input.batchId, input.reason, JSON.stringify({ lifecycleStatus: next })],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  },

  async declareSale(input: { merchantUserId: string; cardNumbers: string[]; declarationRef: string; countryCode: string; evidenceUrl?: string }) {
    if (!input.cardNumbers.length || input.cardNumbers.length > 500) throw new Error('INVALID_CARD_DECLARATION_SIZE');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: existing } = await client.query(`SELECT id FROM konektag.card_sale_declarations WHERE declaration_ref=$1 FOR UPDATE`, [input.declarationRef]);
      if (existing[0]) { await client.query('COMMIT'); return { declarationId: existing[0].id, idempotent: true }; }
      const { rows: cards } = await client.query(
        `SELECT id, amount FROM konektag.cards WHERE number = ANY($1) AND status = 'DISTRIBUTED' AND country_code = $2 AND deleted_at IS NULL FOR UPDATE`,
        [input.cardNumbers.map(number => number.replace(/\s/g, '')), input.countryCode],
      );
      if (cards.length !== input.cardNumbers.length) throw new Error('ONLY_DISTRIBUTED_CARDS_MAY_BE_DECLARED');
      const total = cards.reduce((sum, card) => sum + Number(card.amount), 0);
      const { rows: [declaration] } = await client.query(
        `INSERT INTO konektag.card_sale_declarations (merchant_user_id,declaration_ref,country_code,card_count,total_amount,evidence_url,maker_id)
         VALUES ($1,$2,$3,$4,$5,$6,$1) RETURNING id`,
        [input.merchantUserId, input.declarationRef, input.countryCode, cards.length, total, input.evidenceUrl ?? null],
      );
      for (const card of cards) await client.query(`INSERT INTO konektag.card_sale_declaration_cards (declaration_id, card_id) VALUES ($1,$2)`, [declaration.id, card.id]);
      await client.query(`UPDATE konektag.cards SET status='SOLD', sold_by=$1, sold_at=now(), version=version+1 WHERE id = ANY($2)`, [input.merchantUserId, cards.map(card => card.id)]);
      await client.query('COMMIT');
      return { declarationId: declaration.id, idempotent: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  },
};
