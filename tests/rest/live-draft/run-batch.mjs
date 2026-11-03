#!/usr/bin/env node
// Non-destructive batch on existing K3s API. Existing runner and catalog are reused.
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
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
  } catch (e) {
    console.error('Runner stopped:', e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
