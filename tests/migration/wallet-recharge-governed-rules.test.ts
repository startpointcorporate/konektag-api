import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = 'src/lib/infrastructure/database/migrations/234_wallet_recharge_governed_rules.sql';

describe('wallet recharge governed rules migration', () => {
  it('preserves migration 183 rows but never approves unverified legacy tax data', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain("status = COALESCE(status, 'DRAFT')");
    expect(sql).toContain('LEGACY-MIGRATION-183-UNVERIFIED');
    expect(sql).not.toContain('TEST-FICTIF');
  });

  it('requires explicit approval and rejects overlapping approved periods', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain("status IN ('DRAFT','APPROVED','REVOKED')");
    expect(sql).toContain('WALLET_RECHARGE_TAX_RULE_OVERLAP');
    expect(sql).toContain('WALLET_RECHARGE_LIMIT_RULE_OVERLAP');
    expect(sql).toContain("tstzrange(NEW.valid_from, NEW.valid_until, '[)')");
  });

  it('models explicit zero rates, HALF_UP precision, KYC limits and immutable applications', async () => {
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain("rounding_mode = 'HALF_UP'");
    expect(sql).toContain("calculation_kind = 'PERCENTAGE' AND rate_basis_points IS NOT NULL");
    expect(sql).toContain('minimum_minor BIGINT');
    expect(sql).toContain('per_transaction_minor BIGINT');
    expect(sql).toContain('daily_minor BIGINT');
    expect(sql).toContain('monthly_minor BIGINT');
    expect(sql).toContain('kyc_level TEXT NOT NULL');
    expect(sql).toContain('WALLET_RECHARGE_RULE_APPLICATION_IMMUTABLE');
    expect(sql).toContain('WALLET_RECHARGE_TAX_RULE_MISSING_OR_INACTIVE');
    expect(sql).toContain('WALLET_RECHARGE_LIMIT_RULE_MISSING_OR_INACTIVE');
    expect(sql).toContain('WALLET_RECHARGE_LIMIT_RULE_AMBIGUOUS');
  });
});
