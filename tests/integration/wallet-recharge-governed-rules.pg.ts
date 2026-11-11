// Migration 234 against a real, isolated PostgreSQL.
// WALLET_RECHARGE_PG_TEST_URL must target a throwaway database named konektag_test.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.WALLET_RECHARGE_PG_TEST_URL;
const isolated = !!url && new URL(url).pathname === '/konektag_test';
if (!isolated) throw new Error('WALLET_RECHARGE_PG_TEST_URL must point at a throwaway database named konektag_test');

const migration183 = readFileSync('src/lib/infrastructure/database/migrations/183_wallet_recharge_country_tax_rules.sql', 'utf8');
const migration234 = readFileSync('src/lib/infrastructure/database/migrations/234_wallet_recharge_governed_rules.sql', 'utf8');

describe('wallet recharge governed rules on PostgreSQL', () => {
  let db: pg.Pool;

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await db.query('DROP SCHEMA IF EXISTS konektag CASCADE; CREATE SCHEMA konektag');
    await db.query('CREATE TABLE konektag.api_payment_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
    await db.query(migration183);
    await db.query(`INSERT INTO konektag.wallet_recharge_tax_rules
      (country_code, tax_name, rate_basis_points, enabled, valid_from)
      VALUES ('CG', 'TVA historique non vérifiée', 0, true, DATE '2026-01-01')`);
    await db.query(migration234);
  });

  afterAll(async () => {
    await db?.query('DROP SCHEMA IF EXISTS konektag CASCADE');
    await db?.end();
  });

  it('preserves FR and non-FR legacy rows as non-runnable drafts without inventing metadata', async () => {
    const { rows } = await db.query(`SELECT country_code, currency, minor_digits, status, source_reference
      FROM konektag.wallet_recharge_tax_rules ORDER BY country_code`);
    expect(rows).toEqual([
      { country_code: 'CG', currency: null, minor_digits: null, status: 'DRAFT', source_reference: 'LEGACY-MIGRATION-183-UNVERIFIED' },
      { country_code: 'FR', currency: 'EUR', minor_digits: 2, status: 'DRAFT', source_reference: 'LEGACY-MIGRATION-183-UNVERIFIED' },
    ]);
    await expect(db.query(`SELECT * FROM konektag.resolve_wallet_recharge_tax_rules('FR', 'EUR')`))
      .rejects.toThrow(/WALLET_RECHARGE_TAX_RULE_MISSING_OR_INACTIVE/);
  });

  it('requires complete approval metadata and resolves an explicit approved zero rate', async () => {
    await expect(db.query(`UPDATE konektag.wallet_recharge_tax_rules SET status='APPROVED' WHERE country_code='CG'`))
      .rejects.toThrow(/wallet_recharge_tax_approval_ck/);
    await db.query(`UPDATE konektag.wallet_recharge_tax_rules
      SET status='APPROVED', approval_reference='TEST-FICTIF-APPROVAL', approved_by='integration-test', approved_at=now()
      WHERE country_code='FR'`);
    const { rows } = await db.query(`SELECT country_code, rate_basis_points
      FROM konektag.resolve_wallet_recharge_tax_rules('FR', 'EUR')`);
    expect(rows).toEqual([{ country_code: 'FR', rate_basis_points: 2000 }]);
  });

  it('rejects overlapping approved periods and mutations after application', async () => {
    await expect(db.query(`INSERT INTO konektag.wallet_recharge_tax_rules
      (country_code, currency, tax_name, tax_code, calculation_kind, rate_basis_points, taxable_basis,
       minor_digits, rounding_mode, status, source_reference, approval_reference, approved_by, approved_at, enabled, valid_from)
      VALUES ('FR','EUR','TVA bis','TVA','PERCENTAGE',0,'RECHARGE_AMOUNT',2,'HALF_UP','APPROVED',
       'TEST-FICTIF','TEST-FICTIF-APPROVAL','integration-test',now(),true,DATE '2026-06-01')`))
      .rejects.toThrow(/WALLET_RECHARGE_TAX_RULE_OVERLAP/);

    const order = await db.query(`INSERT INTO konektag.api_payment_orders DEFAULT VALUES RETURNING id`);
    const rule = await db.query(`SELECT id FROM konektag.wallet_recharge_tax_rules WHERE country_code='FR'`);
    await db.query(`INSERT INTO konektag.wallet_recharge_rule_applications(payment_order_id,tax_rule_id,rule_snapshot)
      VALUES ($1,$2,'{"rate_basis_points":2000}'::jsonb)`, [order.rows[0].id, rule.rows[0].id]);
    await expect(db.query(`UPDATE konektag.wallet_recharge_tax_rules SET tax_name='mutated' WHERE id=$1`, [rule.rows[0].id]))
      .rejects.toThrow(/APPLIED_WALLET_RECHARGE_TAX_RULE_IMMUTABLE/);
  });
});
