import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is required');
  process.exit(1);
}

const url = new URL(DATABASE_URL);
const dbName = url.pathname.replace(/^\//, '');
const bootstrapProduction =
  dbName === 'konektag' &&
  process.env.MIGRATION_BOOTSTRAP === 'YES_INITIALIZE_KONEKTAG';

if (dbName !== 'konektag_test' && !bootstrapProduction) {
  console.error(`[migrate] Refusing to migrate database '${dbName}'.`);
  console.error('[migrate] Production bootstrap requires explicit confirmation.');
  process.exit(1);
}

const MIGRATION_LOCK_ID = 772946131;
const SUPERSEDED_147 = '147_pro_subscription_revenue_guide.sql';
const CORRECTIVE_151 = '151_reconcile_pro_subscription_revenue_guide.sql';

function resolveMigrationsDir() {
  const fromSrc = path.join(import.meta.dirname, '../src/lib/infrastructure/database/migrations');
  if (fs.existsSync(fromSrc)) return fromSrc;
  const fromCwd = path.join(process.cwd(), 'src/lib/infrastructure/database/migrations');
  if (fs.existsSync(fromCwd)) return fromCwd;
  throw new Error('Migrations directory not found');
}

function validateMigrationFilename(file) {
  const match = file.match(/^(\d{3})[-_][a-z0-9_-]+\.sql$/);
  if (!match) {
    throw new Error(`Invalid migration filename: ${file} (expected: NNN_description.sql or legacy NNN-description.sql)`);
  }
  return match[1];
}

function assertFinancialMigrationIsSafe(file, sql) {
  const financialTables = [
    'clearing_batches', 'clearing_batch_positions', 'financial_transactions',
    'ledger_entries', 'intercompany_positions', 'merchant_settlements',
  ];
  const dropPattern = new RegExp(
    `\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:konektag\\.)?(${financialTables.join('|')})\\b`,
    'i',
  );
  if (dropPattern.test(sql) && !/FINANCIAL_DROP_APPROVED:\s*\S+/i.test(sql)) {
    throw new Error(`Unsafe financial DROP TABLE in ${file}; use a non-destructive corrective migration instead`);
  }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function main() {
  const migrationsDir = resolveMigrationsDir();

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    console.log('[migrate] Migration lock acquired');

    await client.query('CREATE SCHEMA IF NOT EXISTS konektag');

    const schemaExists = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'konektag')`
    );
    const hasKonektag = schemaExists.rows[0].exists;

    if (hasKonektag) {
      const { rows: tables } = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'konektag'`
      );
      const hasTables = tables.length > 0;

      const hasHistory = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'konektag' AND table_name = 'schema_migrations')`
      );
      const historyExists = hasHistory.rows[0].exists;

      if (hasTables && !historyExists) {
        console.error('[migrate] Database has tables in konektag schema but no schema_migrations history.');
        console.error('[migrate] Manual baseline required. Run diagnostic first.');
        process.exit(1);
      }
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS konektag.schema_migrations (
        version       VARCHAR(200) PRIMARY KEY,
        filename      VARCHAR(200) NOT NULL,
        applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum      VARCHAR(64),
        execution_status TEXT NOT NULL DEFAULT 'APPLIED'
      )
    `);
    await client.query(`ALTER TABLE konektag.schema_migrations ALTER COLUMN version TYPE VARCHAR(200)`);
    await client.query(`ALTER TABLE konektag.schema_migrations
      ADD COLUMN IF NOT EXISTS execution_status TEXT NOT NULL DEFAULT 'APPLIED'`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_migrations_filename ON konektag.schema_migrations(filename)`);

    const { rows: applied } = await client.query(
      'SELECT version, filename, checksum, execution_status FROM konektag.schema_migrations ORDER BY version'
    );
    for (const row of applied) {
      if (row.execution_status !== 'APPLIED' &&
          !(row.filename === SUPERSEDED_147 && row.execution_status === 'SUPERSEDED')) {
        throw new Error(`Invalid migration execution status for ${row.filename}`);
      }
    }
    const appliedMap = new Map(applied.map(r => [r.filename, r.checksum]));

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    if (!files.includes(CORRECTIVE_151)) {
      throw new Error(`Required corrective migration missing: ${CORRECTIVE_151}`);
    }

    for (const file of files) {
      const version = validateMigrationFilename(file);
      if (process.env.MIGRATION_TARGET_VERSION && Number(version) > Number(process.env.MIGRATION_TARGET_VERSION)) break;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      if (appliedMap.has(file)) {
        const existingChecksum = appliedMap.get(file);
        if (existingChecksum && existingChecksum !== (existingChecksum.length===16 ? checksum.slice(0,16) : checksum)) {
          console.error(
            `[migrate] Checksum mismatch for ${file}: stored=${existingChecksum}, current=${checksum}`
          );
          process.exit(1);
        }
        continue;
      }

      // Migrations predating this guard are checksum-immutable. The guard applies to
      // corrective production migrations introduced from 087 onward.
      if (Number(version) >= 87) assertFinancialMigrationIsSafe(file, sql);

      if (file === SUPERSEDED_147) {
        // Do not execute or alter the immutable, invalid historical SQL. Record
        // its exact checksum and explicit status; migration 151 supplies its intent.
        await client.query(
          `INSERT INTO konektag.schema_migrations
           (version, filename, checksum, execution_status) VALUES ($1,$2,$3,'SUPERSEDED')`,
          [`${version}:${file}`, file, checksum],
        );
        console.log(`[migrate] Superseded ${file}; ${CORRECTIVE_151} applies its intended data`);
        continue;
      }

      console.log(`[migrate] Running migration: ${version} (${file})`);
      await client.query(sql);

      await client.query(
        `INSERT INTO konektag.schema_migrations (version, filename, checksum)
         VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
        [`${version}:${file}`, file, checksum]
      );
      console.log(`[migrate] Migration complete: ${version} (${file})`);
    }

    console.log('[migrate] All migrations up to date');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      console.log('[migrate] Migration lock released');
    } catch { /* best effort */ }
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('[migrate] Fatal:', err.message);
  process.exit(1);
});
