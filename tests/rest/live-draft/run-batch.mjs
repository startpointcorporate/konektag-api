#!/usr/bin/env node
// Full real-HTTP campaign against the existing K3s API; never invent data or bypass authentication.
import { readFile, writeFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  const only = option('--only');
  const focusedOperations = only ? only.split(',').map(x => x.trim()).filter(Boolean) : null;
  if (only && !focusedOperations.length) throw new Error('--only requires at least one operation');

  if (externalConfig && (fixturePath || writeRequested)) throw new Error('Use either --config or --fixtures/--allow-fixture-writes');
  // Authenticate only the already designated test identity, never create or alter a user.
  // A short-lived token stays in this process and is never written to the fixtures/report.
  if (!externalConfig && !fixturePath && !process.env.REST_LIVE_OWNER_TOKEN && !args.includes('--anonymous')) {
    if (!process.stdin.isTTY) throw new Error('Owner token missing in non-interactive mode. Set REST_LIVE_OWNER_TOKEN or use --anonymous.');
    // Read from the controlling terminal directly. This works even when npm wraps
    // stdout and prevents a readline prompt from being displayed.
    const input = spawnSync('bash', ['-c',
      "IFS= read -r -s -p 'Mot de passe Keycloak de konektag-test-002 : ' password </dev/tty || exit; printf '\\n' >/dev/tty; printf '%s' \"$password\""
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (input.status !== 0 || !input.stdout) throw new Error('Saisie du mot de passe annulée');
    let password = input.stdout;
    try {
      const response = await fetch('https://login.konektag.eu/realms/konektag/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password', client_id: 'frontend-konektag',
          username: 'konektag-test-002', password
        }),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`Keycloak test account authentication failed: HTTP ${response.status}`);
      const data = await response.json();
      if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Keycloak returned no user access token');
      process.env.REST_LIVE_OWNER_TOKEN = data.access_token;
      console.log('Identité de recette authentifiée : konektag-test-002');
    } finally {
      password = undefined;
    }
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'konektag-rest-'));
  let configFile = externalConfig ? path.resolve(externalConfig) : path.join(dir, 'config.json');
  if (!externalConfig) {
    const fixturesFile = fixturePath ? path.resolve(fixturePath) : path.join(dir, 'fixtures.json');
    if (!fixturePath) {
      const empty = { actors: {
        // Explicitly designated existing test user; enabled only when its token is supplied.
        ...(process.env.REST_LIVE_OWNER_TOKEN ? { owner: {
          testOnly: true, username: 'konektag-test-002', tokenEnv: 'REST_LIVE_OWNER_TOKEN', auth: 'bearer'
        } } : {})
      }, resources: {}, vars: {}, cases: {} };
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
      ...(focusedOperations ? { operations: focusedOperations } : {}),
      fixtures: fixturesFile,
      postgresql: { k3sExec: { sshHost: 'konektag-core', namespace: 'konektag-api', deployment: 'konektag-api' } },
      allowFixtureWrites: writeRequested && Boolean(fixturePath),
      outputDirectory: path.join(dir, 'results')
    };
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  await campaign(root, configFile);
  const settings = JSON.parse(await readFile(configFile, 'utf8'));
  const reportDir = path.resolve(settings.outputDirectory || 'work/rest-live-results');
  const runs = (await readdir(reportDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const report = JSON.parse(await readFile(path.join(reportDir, runs.at(-1), 'results.json'), 'utf8'));
  const considered = focusedOperations ? report.operations.filter(r => focusedOperations.includes(r.operation)) : report.operations;
  const focusedSummary = Object.fromEntries(['PASS','FAIL','BLOCKED','NOT TESTED'].map(key => [key, considered.filter(r => r.status === key).length]));
  console.log('REST', considered.length, focusedOperations ? 'selected operations:' : 'operations:', JSON.stringify(focusedSummary));
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
