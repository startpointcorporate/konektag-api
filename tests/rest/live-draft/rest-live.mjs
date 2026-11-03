#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { campaign } from './engine.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  console.error('Usage: node tests/rest/live-draft/rest-live.mjs -- --config /chemin/prive/rest-live.json');
  process.exitCode = 2;
} else {
  try { await campaign(root, args[1]); }
  catch { console.error('Configuration/runner failure. No credentials or raw error details printed.'); process.exitCode = 2; }
}
