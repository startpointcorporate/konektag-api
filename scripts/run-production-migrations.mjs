import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_LOCK_ID = 772946131;
const EXPECTED_SCHEMA = 'konektag';
const PRODUCTION_CONFIRMATION = 'YES_RUN_PRODUCTION_MIGRATIONS';
const SUPERSEDED_147 = '147_pro_subscription_revenue_guide.sql';
const CORRECTIVE_151 = '151_reconcile_pro_subscription_revenue_guide.sql';
const FINANCIAL_TABLES = [
  'clearing_batches', 'clearing_batch_positions', 'financial_transactions',
  'ledger_entries', 'intercompany_positions', 'merchant_settlements',
];

function fail(message) {
  console.error(`[production-migrate] REFUSED: ${message}`);
  process.exit(1);
}

if (!DATABASE_URL) fail('DATABASE_URL is required');
if (process.env.MIGRATION_TARGET !== 'production') fail('MIGRATION_TARGET must be exactly production');
if (process.env.MIGRATION_PRODUCTION_CONFIRMATION !== PRODUCTION_CONFIRMATION) {
  fail(`MIGRATION_PRODUCTION_CONFIRMATION must be exactly ${PRODUCTION_CONFIRMATION}`);
}

// GAP-019/GAP-026: the canonical production database name comes from the
// deployment configuration contract (POSTGRES_DB). It is never hard-coded,
// never inferred from the URL, and never defaulted to an implicit fallback.
const CANONICAL_DATABASE = (process.env.POSTGRES_DB ?? '').trim();
if (!CANONICAL_DATABASE) {
  fail('POSTGRES_DB is required (canonical production database name)');
}

let url;
try {
  url = new URL(DATABASE_URL);
} catch {
  fail('DATABASE_URL is not a valid URL');
}

const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!dbName) fail('DATABASE_URL must name a database');
if (dbName !== CANONICAL_DATABASE) {
  // Names are target identifiers, never credentials: safe to report.
  fail(`DATABASE_URL database '${dbName}' does not match canonical POSTGRES_DB '${CANONICAL_DATABASE}'`);
}
// The implicit shared 'postgres' database is a prohibited deployment fallback
// (GAP-019 preflight contract). The rejection applies only when the active
// deployment contract is signalled; local development databases are unaffected.
if (process.env.MIGRATION_REJECT_FALLBACK_DATABASE === 'true' && dbName.toLowerCase() === 'postgres') {
  fail("database name 'postgres' is a prohibited deployment fallback");
}
if (url.searchParams.has('options') || url.searchParams.has('search_path')) {
  fail('DATABASE_URL must not override the PostgreSQL search path');
}

function resolveMigrationsDir() {
  const fromScript = path.join(import.meta.dirname, '../src/lib/infrastructure/database/migrations');
  if (fs.existsSync(fromScript)) return fromScript;
  const fromCwd = path.join(process.cwd(), 'src/lib/infrastructure/database/migrations');
  if (fs.existsSync(fromCwd)) return fromCwd;
  throw new Error('Migrations directory not found');
}

function loadMigrations(migrationsDir) {
  return fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => {
      if (!/^(\d{3})[-_][a-z0-9_-]+\.sql$/.test(file)) {
        throw new Error(`Invalid migration filename: ${file}`);
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const destructive = new RegExp(
        `\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:${EXPECTED_SCHEMA}\\.)?(${FINANCIAL_TABLES.join('|')})\\b`,
        'i',
      );
      if (/^\s*ROLLBACK\s*;\s*$/im.test(sql)) {
        throw new Error(`Rollback control statement found in ${file}`);
      }
      return {
        file,
        version: file.slice(0, 3),
        // The runner owns the transaction so DDL and its history entry commit together.
        sql: sql.replace(/^\s*(?:BEGIN|COMMIT)\s*;\s*$/gim, ''),
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
        hasFinancialDrop: destructive.test(sql),
      };
    });
}

function validateHistory(applied, migrations) {
  const byFilename = new Map();
  for (const row of applied) {
    if (!row.filename || !row.checksum) {
      throw new Error(`Migration history contains an incomplete entry (${row.version ?? 'unknown version'})`);
    }
    if (byFilename.has(row.filename)) {
      throw new Error(`Migration history contains duplicate filename ${row.filename}`);
    }
    if (row.execution_status !== 'APPLIED' &&
        !(row.filename === SUPERSEDED_147 && row.execution_status === 'SUPERSEDED')) {
      throw new Error(`Invalid migration execution status for ${row.filename}`);
    }
    byFilename.set(row.filename, row);
  }

  const files = new Set(migrations.map(migration => migration.file));
  for (const filename of byFilename.keys()) {
    if (!files.has(filename)) throw new Error(`Migration history references missing source file ${filename}`);
  }

  for (const migration of migrations) {
    const appliedMigration = byFilename.get(migration.file);
    if (appliedMigration && appliedMigration.checksum !== migration.checksum) {
      throw new Error(`Checksum mismatch for ${migration.file}`);
    }
  }

  // The recorded history must form one contiguous prefix of the ordered
  // source chain. A partial, gapped or out-of-order history (a later
  // migration recorded without its predecessors) is rejected here instead of
  // being silently completed or baselined over.
  // Corrective 151 may be applied before CORE-01 adds migrations 149 and 150.
  // Its intent is independent of those migrations. Keep every other entry
  // contiguous, including 149 and 150 once they are introduced.
  const orderedWithoutEarlyCorrection = migrations.filter(migration =>
    migration.file !== CORRECTIVE_151);
  const recordedWithoutEarlyCorrection = byFilename.size - Number(byFilename.has(CORRECTIVE_151));
  const prefix = orderedWithoutEarlyCorrection.slice(0, recordedWithoutEarlyCorrection);
  for (const migration of prefix) {
    if (!byFilename.has(migration.file)) {
      throw new Error(
        `Migration history is not a contiguous prefix: ${migration.file} is missing while later migrations are recorded`,
      );
    }
  }
  return byFilename;
}

async function assertConvergenceContract(client) {
  // The history records execution, not proof of a current schema. Verify the
  // objects that were formerly skipped by the unsafe 001-083 baseline.
  const requiredTables = [
    'transfer_confirm_tokens', 'communication_consents', 'referral_codes',
    'referral_redemptions', 'merchant_kyb_documents', 'klot_allocations',
    'refund_intents', 'acquisition_confirmations', 'checkout_intents',
    'integration_operations',
  ];
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2)`,
    [EXPECTED_SCHEMA, requiredTables],
  );
  const presentTables = new Set(tables.map(row => row.table_name));
  const missingTables = requiredTables.filter(table => !presentTables.has(table));
  if (missingTables.length) throw new Error(`Convergence contract missing table(s): ${missingTables.join(', ')}`);

  const requiredColumns = [
    ['financial_transactions', 'command_hash'], ['financial_transactions', 'reversal_reason'],
    ['financial_transactions', 'eligibility_decision'], ['klots', 'remaining_quantity'],
    ['acquisition_confirmations', 'operation_id'], ['acquisition_confirmations', 'idempotency_key'],
    ['integration_operations', 'integration_type'], ['checkout_intents', 'token_hash'],
  ];
  const { rows: columns } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = $1 AND (table_name, column_name) IN (${requiredColumns.map((_, index) => `($${index * 2 + 2}, $${index * 2 + 3})`).join(', ')})`,
    [EXPECTED_SCHEMA, ...requiredColumns.flat()],
  );
  const presentColumns = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
  const missingColumns = requiredColumns
    .map(([table, column]) => `${table}.${column}`)
    .filter(column => !presentColumns.has(column));
  if (missingColumns.length) throw new Error(`Convergence contract missing column(s): ${missingColumns.join(', ')}`);

  const requiredConstraints = ['ck_finalized_dimensions', 'ck_reversal_fields', 'fk_financial_tx_source_operation'];
  const { rows: constraints } = await client.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'konektag.financial_transactions'::regclass AND conname = ANY($1)`,
    [requiredConstraints],
  );
  const presentConstraints = new Set(constraints.map(row => row.conname));
  const missingConstraints = requiredConstraints.filter(constraint => !presentConstraints.has(constraint));
  if (missingConstraints.length) throw new Error(`Convergence contract missing constraint(s): ${missingConstraints.join(', ')}`);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function main() {
  const migrations = loadMigrations(resolveMigrationsDir());
  if (!migrations.some(migration => migration.file === CORRECTIVE_151)) {
    throw new Error(`Required corrective migration missing: ${CORRECTIVE_151}`);
  }
  const client = await pool.connect();
  try {
    console.log(`[production-migrate] Target verified: ${CANONICAL_DATABASE}.${EXPECTED_SCHEMA}`);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    console.log('[production-migrate] Advisory lock acquired');

    const schema = await client.query(
      'SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS exists',
      [EXPECTED_SCHEMA],
    );
    if (!schema.rows[0].exists) throw new Error(`Required schema ${EXPECTED_SCHEMA} does not exist; refusing to create it in production`);

    const historyTable = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'schema_migrations'
      ) AS exists`,
      [EXPECTED_SCHEMA],
    );
    if (!historyTable.rows[0].exists) {
      throw new Error('schema_migrations does not exist; production migrations refuse to baseline or fabricate history');
    }

    const statusColumn = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='schema_migrations' AND column_name='execution_status') AS exists`,
      [EXPECTED_SCHEMA],
    );
    const statusProjection = statusColumn.rows[0].exists
      ? 'execution_status' : "'APPLIED'::text AS execution_status";
    const { rows: applied } = await client.query(
      `SELECT version, filename, checksum, ${statusProjection}
       FROM ${EXPECTED_SCHEMA}.schema_migrations ORDER BY applied_at, version`,
    );
    const appliedByFilename = validateHistory(applied, migrations);
    console.log(`[production-migrate] History verified: ${applied.length} recorded migration(s), ${migrations.length} source file(s)`);

    const pending = migrations.filter(migration => !appliedByFilename.has(migration.file));
    if (pending.length === 0) {
      await assertConvergenceContract(client);
      console.log('[production-migrate] Convergence contract verified');
      console.log('[production-migrate] No pending migrations; schema is up to date');
      return;
    }

    console.log(`[production-migrate] Applying ${pending.length} pending migration(s): ${pending.map(migration => migration.file).join(', ')}`);
    for (const migration of pending) {
      if (migration.hasFinancialDrop) {
        throw new Error(`Unsafe financial DROP TABLE in pending migration ${migration.file}; use a non-destructive corrective migration instead`);
      }
      console.log(`[production-migrate] Applying ${migration.file}`);
      await client.query('BEGIN');
      try {
        if (migration.file === SUPERSEDED_147) {
          await client.query(`ALTER TABLE ${EXPECTED_SCHEMA}.schema_migrations
            ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'APPLIED'`);
          await client.query(
            `INSERT INTO ${EXPECTED_SCHEMA}.schema_migrations
             (version, filename, checksum, execution_status) VALUES ($1,$2,$3,'SUPERSEDED')`,
            [`${migration.version}:${migration.file}`, migration.file, migration.checksum],
          );
          await client.query('COMMIT');
          console.log(`[production-migrate] Superseded ${migration.file}; ${CORRECTIVE_151} applies its intended data`);
          continue;
        }
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${EXPECTED_SCHEMA}.schema_migrations (version, filename, checksum)
           VALUES ($1, $2, $3)`,
          [`${migration.version}:${migration.file}`, migration.file, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
      console.log(`[production-migrate] Applied ${migration.file}`);
    }
    await assertConvergenceContract(client);
    console.log('[production-migrate] Convergence contract verified');
    console.log('[production-migrate] Production migrations completed successfully');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      console.log('[production-migrate] Advisory lock released');
    } catch { /* best effort after a connection failure */ }
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error('[production-migrate] FAILED:', error.message);
  process.exit(1);
});
