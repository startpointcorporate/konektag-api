import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/** Synthetic opening balance only, never a payment simulation on a shared database.
 * Runtime commands tested afterwards use all normal triggers and constraints. */
export async function isolatedKUser(pool: Pool, quantity = 100, state = 'KYC_VALIDATED') {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.pathname !== '/konektag_test' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('Local throwaway database required');
  const id = randomUUID(), keycloak = randomUUID();
  await pool.query(`INSERT INTO konektag.users(id,keycloak_id,username,email_hash,encrypted_data,state,country)
    VALUES($1::uuid,$2::uuid,$1::text,$3,'\\x00',$4,'FR')`, [id,keycloak,id.replaceAll('-','').padEnd(64,'0'),state]);
  const { rows: [party] } = await pool.query(`INSERT INTO konektag.parties(party_type,keycloak_id,display_name)
    VALUES('individual',$1,$2) RETURNING id`, [keycloak,id]);
  if (quantity > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      const { rows: [tx] } = await client.query(`INSERT INTO konektag.financial_transactions
        (transaction_type,business_reference,idempotency_key,currency,status,completed_at,legal_entity_id,corridor_id,regulatory_profile_id,operation_id,value_date,eligibility_decision)
        SELECT 'acquisition',$1,$1,'K','completed',now(),legal_entity_id,corridor_id,id,$1,CURRENT_DATE,'ALLOWED' FROM konektag.regulatory_profiles LIMIT 1 RETURNING id`, ['isolated-opening:'+id]);
      await client.query(`INSERT INTO konektag.ledger_entries(transaction_id,account_code,entry_type,entry_side,
        party_id,amount,currency,gl_scope,document_type,document_ref)
        VALUES($1,'1000','credit','credit',$2,$3,'K','GLOBAL_USER_GL','test_opening',$4),
         ($1,'K_ISSUANCE','debit','debit',NULL,$3,'K','GLOBAL_USER_GL','test_opening',$4)`,[tx.id,party.id,quantity,id]);
      await client.query(`INSERT INTO konektag.k_wallet_entries(party_id,operation_id,operation_type,direction,quantity_k,source_type,source_id)
        VALUES($1,$2::uuid,'purchase','credit',$3,'test_opening',$2::text)`,[party.id,tx.id,quantity]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  return { id, keycloak_id:keycloak, party:party.id as string, email:'isolated@example.test' };
}
