#!/usr/bin/env node
// Full real-HTTP campaign against the existing K3s API; never invent data or bypass authentication.
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { campaign } from './engine.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value after ${name}`);
  return args[index + 1];
};
try {
  const externalConfig = option('--config') || process.env.REST_LIVE_CONFIG;
  const fixturePath = option('--fixtures') || process.env.REST_LIVE_FIXTURES;
  const writeRequested = args.includes('--allow-fixture-writes');
  if (externalConfig && (fixturePath || writeRequested)) throw new Error('Use either --config or --fixtures/--allow-fixture-writes');
  const dir = await mkdtemp(path.join(tmpdir(), 'konektag-rest-'));
  let configFile = externalConfig ? path.resolve(externalConfig) : path.join(dir, 'config.json');
  if (!externalConfig) {
    const fixturesFile = fixturePath ? path.resolve(fixturePath) : path.join(dir, 'fixtures.json');
    if (!fixturePath) {
      const empty = { actors: {}, resources: {}, vars: {}, cases: {} };
      await writeFile(fixturesFile, JSON.stringify(empty), { mode: 0o600 });
    } else {
      // Fail fast on invalid/private fixture shape, rather than silently running an empty campaign.
      const supplied = JSON.parse(await readFile(fixturesFile, 'utf8'));
      for (const key of ['actors', 'resources', 'vars', 'cases']) {
        if (!supplied[key] || typeof supplied[key] !== 'object' || Array.isArray(supplied[key])) throw new Error(`Fixture key ${key} must be an object`);
      }
    }
    const config = {
      baseUrl: 'https://api.konektag.eu',
      fixtures: fixturesFile,
      postgresql: { k3sExec: { sshHost: 'konektag-core', namespace: 'konektag-api', deployment: 'konektag-api' } },
      allowFixtureWrites: writeRequested && Boolean(fixturePath),
      outputDirectory: path.join(dir, 'results')
    };
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  await campaign(root, configFile);
  const settings = JSON.parse(await readFile(configFile, 'utf8'));
  const reportDir = path.resolve(path.dirname(configFile), settings.outputDirectory || 'work/rest-live-results');
  const runs = (await readdir(reportDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const report = JSON.parse(await readFile(path.join(reportDir, runs.at(-1), 'results.json'), 'utf8'));
  console.log('REST', report.operations.length, 'operations:', JSON.stringify(report.summary));
  for (const row of report.operations.filter(row => row.status === 'FAIL')) {
    console.error('FAIL', row.operation, row.scenarios?.[0]?.reason || row.reason || '');
  }
  const blocked = report.operations.filter(row => row.status === 'BLOCKED');
  const groups = new Map();
  for (const row of blocked) {
    const reason = row.reason || row.scenarios?.[0]?.reason || 'Unspecified prerequisite';
    const label = reason.startsWith('Fixture required: cases.') ? 'Missing per-operation business fixture' : reason;
    groups.set(label, (groups.get(label) || 0) + 1);
  }
  if (blocked.length) {
    console.log('BLOCKED summary:');
    for (const [reason, count] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${count} × ${reason}`);
    console.log('Fixtures specification: tests/rest/live-draft/fixture-requirements.json');
    if (!fixturePath && !externalConfig) console.log('Provide existing dedicated test data with --fixtures /absolute/private/fixtures.json (or REST_LIVE_FIXTURES).');
  }
  console.log('Full report:', path.join(reportDir, runs.at(-1), 'results.md'));
  if (report.summary.FAIL) process.exitCode = 1;
} catch (error) {
  console.error('REST live runner:', error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
