import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('work',{recursive:true});
const run = (script, args) => {
  const result = spawnSync(process.execPath,[script,...args],{stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
run('src/infrastructure/scripts/openapi.mjs',[]);
// Reuse the entire existing Vitest suite so reviewed unit/migration evidence must actually run.
run('node_modules/vitest/vitest.mjs',['run','--reporter=default','--reporter=json','--outputFile.json=work/rest-results.json']);
run('src/infrastructure/scripts/rest-coverage.mjs',process.argv.slice(2));
