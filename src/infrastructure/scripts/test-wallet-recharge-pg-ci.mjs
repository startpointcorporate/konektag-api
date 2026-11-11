import { spawnSync } from 'node:child_process';

// The ordinary local suite remains service-free. GitHub's existing coverage
// job provides Docker, so exercise migration 234 there without changing the
// protected workflow file or requiring a shared database.
if (process.env.GITHUB_ACTIONS !== 'true') process.exit(0);

const container = `konektag-wallet-recharge-pg-${process.pid}`;
const port = 55432;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
};

try {
  run('docker', ['run', '--detach', '--rm', '--name', container,
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=konektag_test',
    '-p', `${port}:5432`, 'postgres:16']);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'konektag_test']);
    if (probe.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('PostgreSQL test container did not become ready');
  run('npm', ['run', 'test:wallet-recharge:pg'], { env: {
    ...process.env,
    WALLET_RECHARGE_PG_TEST_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/konektag_test`,
  } });
} finally {
  spawnSync('docker', ['rm', '--force', container], { stdio: 'ignore' });
}
