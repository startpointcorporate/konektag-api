#!/usr/bin/env node
// Non-destructive batch on existing K3s API. Existing runner and catalog are reused.
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { campaign } from './engine.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const index = args.indexOf('--config');
const external = index >= 0 ? args[index + 1] : null;
if (index >= 0 && !external) {
  console.error('Usage: npm run test:rest:live -- --config /private/config.json');
  process.exitCode = 2;
} else {
  let configFile = external;
  if (!configFile) {
    const dir = await mkdtemp(path.join(tmpdir(), 'konektag-rest-'));
    const fixtures = { actors: {}, resources: {}, vars: {}, cases: {} };
    // No operation filter: the existing runner processes the full catalog.
    // Missing actors/fixtures and unsafe writes are explicitly BLOCKED, never silently excluded.
    await writeFile(path.join(dir, 'fixtures.json'), JSON.stringify(fixtures), { mode: 0o600 });
    configFile = path.join(dir, 'config.json');
    const config = {
      baseUrl: 'https://api.konektag.eu',
      fixtures: 'fixtures.json',
      postgresql: { k3sExec: { sshHost: 'konektag-core', namespace: 'konektag-api', deployment: 'konektag-api' } },
      allowFixtureWrites: false, // enable only with explicit test-owned fixtures
      outputDirectory: path.join(dir, 'results')
    };
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  try {
    await campaign(root, configFile);
    const settings = JSON.parse(await readFile(configFile, 'utf8'));
    const { readdir } = await import('node:fs/promises');
    const reportDir = settings.outputDirectory || 'work/rest-live-results';
    const runs = (await readdir(reportDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    if (runs.length) {
      const report = JSON.parse(await readFile(path.join(reportDir, runs.at(-1), 'results.json'), 'utf8'));
      console.log('REST', report.operations.length, 'operations :', JSON.stringify(report.summary));
      for (const row of report.operations.filter(row => row.status === 'FAIL')) console.error('FAIL', row.operation, row.scenarios?.[0]?.reason || row.reason || '');
      for (const row of report.operations.filter(row => row.status === 'BLOCKED' && !String(row.reason || '').startsWith('Fixture required:'))) console.log('BLOCKED', row.operation, row.reason || '');
    }
  } catch (e) {
    console.error('Runner stopped:', e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
