import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createClient } from 'redis';

// No server/handler imports: every scenario crosses the deployed HTTP boundary.
export class Blocked extends Error {}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const at = (value, pointer = '') => pointer === '' ? value : pointer.split('/').slice(1)
  .reduce((v, k) => v?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], value);
const subset = (value, expected) => {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(value), 'array expected');
    assert.equal(value.length, expected.length, 'array length');
    expected.forEach((v, i) => subset(value[i], v));
  } else if (expected && typeof expected === 'object') {
    assert.ok(value && typeof value === 'object', 'object expected');
    for (const [k, v] of Object.entries(expected)) subset(value[k], v);
  } else assert.deepEqual(value, expected);
};

export async function campaign(root, configFile) {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') throw new Error('HTTPS API origin required');
  if (!(config.allowedHosts || []).includes(hostname())) throw new Error('Run from the configured VPS3 hostname');
  if (config.workersDisabled !== true || config.mcpDisabled !== true) throw new Error('Explicit workersDisabled/mcpDisabled attestation required');
  const fixture = JSON.parse(await readFile(path.resolve(path.dirname(configFile), config.fixtures), 'utf8'));
  const vars = { ...fixture.vars, run: { id: `rest-test-${randomUUID()}` }, captured: {} };
  const expand = value => {
    if (typeof value === 'string') {
      const resolve = key => {
        const found = key.split('.').reduce((v, k) => v?.[k], vars);
        if (found === undefined || found === null || found === '' || String(found).startsWith('REPLACE_')) throw new Blocked(`Fixture required: ${key}`);
        return found;
      };
      const match = /^\$\{([^}]+)\}$/.exec(value);
      return match ? resolve(match[1]) : value.replace(/\$\{([^}]+)\}/g, (_, k) => String(resolve(k)));
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
    return value;
  };
  const requiredEnv = name => {
    if (!name || !process.env[name]) throw new Blocked(`Configuration required: ${name || 'environment variable name'}`);
    return process.env[name];
  };
  const pool = config.postgresql?.urlEnv && process.env[config.postgresql.urlEnv]
    ? new pg.Pool({ connectionString: process.env[config.postgresql.urlEnv], max: 1, connectionTimeoutMillis: 8000,
      statement_timeout: 10000, options: '-c default_transaction_read_only=on',
      ...(config.postgresql.caEnv ? { ssl: { ca: requiredEnv(config.postgresql.caEnv), rejectUnauthorized: true } } : {}) }) : null;
  let redis;
  const dependencyResults = new Map();
  const report = { schemaVersion: 1, execution: 'EXECUTED', startedAt: new Date().toISOString(), sourceHost: hostname(),
    baseUrl: base.origin, runId: vars.run.id, operations: [], dependencies: [], cleanup: [], requests: 0 };
  const output = path.resolve(config.outputDirectory || 'work/rest-live-results', vars.run.id);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sql = async descriptor => {
    if (!pool) throw new Blocked('PostgreSQL observer connection unavailable');
    const q = expand(descriptor);
    if (!/^\s*(SELECT|WITH)\b/i.test(q.sql) || q.sql.includes(';')) throw new Error('Only repository-authored single read-only SQL statements allowed');
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const result = await client.query(q.sql, q.params || []);
      await client.query('COMMIT');
      return JSON.parse(JSON.stringify(result.rows));
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  };
  const serviceFetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Provider HTTPS required');
    return fetch(u, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  };
  const dependency = async name => {
    if (dependencyResults.has(name)) {
      const result = dependencyResults.get(name);
      if (result.status !== 'PASS') throw new Blocked(result.reason);
      return;
    }
    const result = { name, status: 'BLOCKED' };
    try {
      if (name === 'PostgreSQL') assert.equal((await sql({ sql: 'SELECT 1::int AS ok' }))[0].ok, 1);
      else if (name === 'Valkey') {
        redis = createClient({ url: requiredEnv(config.valkey?.urlEnv), socket: { connectTimeout: 8000, reconnectStrategy: false } });
        redis.on('error', () => {});
        await redis.connect(); assert.equal(await redis.ping(), 'PONG');
      } else if (name === 'Keycloak') {
        const realm = config.keycloak?.realmUrl;
        if (!realm) throw new Blocked('Keycloak realmUrl required');
        const response = await serviceFetch(`${realm}/.well-known/openid-configuration`);
        assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.issuer, realm);
        assert.ok(data.jwks_uri && data.token_endpoint, 'OIDC metadata');
      } else if (name === 'ERPNext/Frappe') {
        const erp = config.erpnext;
        if (!erp?.url) throw new Blocked('ERPNext/Frappe URL required');
        const response = await serviceFetch(`${erp.url}/api/method/frappe.auth.get_logged_user`, {
          headers: { Authorization: `token ${requiredEnv(erp.apiKeyEnv)}:${requiredEnv(erp.apiSecretEnv)}` } });
        assert.equal(response.status, 200); assert.equal(typeof (await response.json()).message, 'string');
      } else if (name === 'Resend') {
        // Receiving permission alone is insufficient: dedicated test mailbox must be declared.
        if (!config.resend?.testRecipients?.length) throw new Blocked('Resend testRecipients allowlist required');
        const response = await serviceFetch('https://api.resend.com/emails', { headers: { Authorization: `Bearer ${requiredEnv(config.resend.apiKeyEnv)}` } });
        assert.equal(response.status, 200); assert.ok(Array.isArray((await response.json()).data));
      } else {
        const provider = config.providers?.[name];
        if (!provider?.probeUrl || !provider.assertions?.length) throw new Blocked(`NON TESTABLE — DÉPENDANCE INDISPONIBLE: ${name} (configuration de sonde absente)`);
        const response = await serviceFetch(provider.probeUrl, { headers: provider.tokenEnv ? { Authorization: `Bearer ${requiredEnv(provider.tokenEnv)}` } : {} });
        assert.equal(response.status, 200); check(await response.json(), expand(provider.assertions));
      }
      result.status = 'PASS';
    } catch { result.reason = `NON TESTABLE — DÉPENDANCE INDISPONIBLE OU SONDE ÉCHOUÉE: ${name}`; }
    dependencyResults.set(name, result); report.dependencies.push(result);
    if (result.status !== 'PASS') throw new Blocked(result.reason);
  };
  function check(body, assertions) {
    for (const a of assertions) {
      const value = at(body, a.path);
      if ('equals' in a) assert.deepEqual(value, a.equals, a.path);
      if ('subset' in a) subset(value, a.subset);
      if ('contains' in a) { assert.ok(Array.isArray(value), a.path); assert.ok(value.some(item => { try { subset(item, a.contains); return true; } catch { return false; } }), a.path); }
      if ('excludes' in a) { assert.ok(Array.isArray(value), a.path); assert.ok(!value.some(item => { try { subset(item, a.excludes); return true; } catch { return false; } }), a.path); }
      if (a.type) assert.ok(a.type === 'array' ? Array.isArray(value) : a.type === 'integer' ? Number.isSafeInteger(value) : typeof value === a.type, a.path);
      if ('min' in a) assert.ok(value >= a.min, a.path);
      if ('max' in a) assert.ok(value <= a.max, a.path);
      if (a.matches) assert.match(value, new RegExp(a.matches), a.path);
      if (a.absent) assert.equal(value, undefined, a.path);
    }
  }
  const verifiedActors = new Set();
  const actor = async name => {
    if (!name) return {};
    const identity = fixture.actors?.[name];
    if (!identity?.testOnly || !identity.userId || !identity.keycloakId || !identity.username) throw new Blocked(`Existing test account required: ${name}`);
    const token = requiredEnv(identity.tokenEnv);
    if (!verifiedActors.has(name)) {
      await dependency('PostgreSQL'); await dependency('Keycloak');
      const response = await serviceFetch(`${config.keycloak.realmUrl}/protocol/openid-connect/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status !== 200) throw new Blocked(`Valid test account token required: ${name}`);
      const info = await response.json();
      assert.equal(info.sub, identity.keycloakId, 'Keycloak identity mismatch');
      const users = await sql({ sql: 'SELECT id,keycloak_id,username,role FROM konektag.users WHERE id=$1 AND deleted_at IS NULL', params: [identity.userId] });
      assert.equal(users.length, 1); subset(users[0], { keycloak_id: identity.keycloakId, username: identity.username, role: identity.role });
      vars[name] = { ...identity }; verifiedActors.add(name);
    }
    return { Authorization: `Bearer ${token}` };
  };
  const resourceGuard = async names => {
    for (const name of names || []) {
      const resource = fixture.resources?.[name];
      const guard = guards[name];
      if (!resource?.testOnly || !guard) throw new Blocked(`Test-owned resource required: ${name}`);
      // Guard SQL comes from versioned code, never the operator's configuration file.
      vars[name] = resource;
      if (!(await sql(guard)).length) throw new Blocked(`Ownership / test marker not established: ${name}`);
    }
  };
  const { guards, snapshots } = JSON.parse(await readFile(path.join(root, 'tests/rest/live/oracles.json'), 'utf8'));
  const request = async step => {
    const headers = { ...(await actor(step.actor)), ...(step.internalToken ? { Authorization: `Bearer ${requiredEnv(config.internalTokenEnv)}` } : {}) };
    const expanded = expand(step);
    const target = new URL(expanded.path, base);
    if (target.origin !== base.origin || target.username || target.password || !target.pathname.startsWith('/')) throw new Error('Cross-origin request forbidden');
    const init = { method: expanded.method, headers: { ...headers, ...expanded.headers }, redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs || 15000) };
    if (expanded.origin !== false) init.headers.Origin = base.origin;
    if ('body' in expanded) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(expanded.body); }
    if ('raw' in expanded) { init.headers['Content-Type'] = 'application/json'; init.body = expanded.raw; }
    if ('form' in expanded) { init.body = new FormData(); for (const [k,v] of Object.entries(expanded.form)) init.body.set(k, String(v)); }
    report.requests++;
    const response = await fetch(target, init);
    assert.equal(response.status, expanded.status, 'HTTP status');
    let body;
    if (expanded.sse) {
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
      const reader = response.body.getReader(); let text = '';
      try { while (!text.includes('\n\n')) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); if (text.length > 65536) throw new Error('SSE frame too large'); } }
      finally { await reader.cancel(); }
      assert.match(text, /event: status_update/); body = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] || '{}');
    } else if (expanded.binary) {
      const data = new Uint8Array(await response.arrayBuffer());
      assert.ok(data.length > 0, 'nonempty document');
      body = { sha256: createHash('sha256').update(data).digest('hex'), prefix: Buffer.from(data.subarray(0, 8)).toString('latin1') };
    } else if (expanded.text) body = await response.text();
    else if (response.status !== 204 && response.status !== 303) {
      // Some historical handlers intentionally omit application/json. Preserve that contract.
      body = JSON.parse(await response.text());
    }
    check(body, expanded.assertions || []);
    for (const [k, v] of Object.entries(expanded.responseHeaders || {})) assert.match(response.headers.get(k) || '', new RegExp(v), k);
    for (const [name, pointer] of Object.entries(expanded.capture || {})) {
      const value = at(body, pointer); assert.notEqual(value, undefined, 'capture missing'); vars.captured[name] = value;
    }
    for (const oracle of step.oracles || []) {
      const rows = await sql(oracle);
      if ('equals' in oracle) assert.deepEqual(rows, expand(oracle.equals));
      if (oracle.assertions) check(rows, expand(oracle.assertions));
      if (oracle.responsePath !== undefined) {
        const actual = at(body, oracle.responsePath);
        const expected = oracle.column ? rows.map(r => r[oracle.column]) : rows;
        if (oracle.mode === 'subset') subset(actual, oracle.single ? expected[0] : expected);
        else if (oracle.mode === 'contains') for (const expectedRow of expected) check(actual, [{ path: '', contains: expectedRow }]);
        else assert.deepEqual(actual, oracle.single ? expected[0] : expected);
      }
    }
    if (step.resendEvidence) {
      const email = expand(step.resendEvidence);
      if (!config.resend.testRecipients.includes(email)) throw new Error('Email recipient outside test allowlist');
      // Resend's own event log is the oracle; HTTP 200 from Konektag is insufficient.
      const response = await serviceFetch('https://api.resend.com/emails', { headers: { Authorization: `Bearer ${requiredEnv(config.resend.apiKeyEnv)}` } });
      assert.equal(response.status, 200); const log = await response.json();
      assert.ok(log.data.some(e => (Array.isArray(e.to) ? e.to : [e.to]).includes(email) && Date.parse(e.created_at) >= Date.parse(report.startedAt)
        && !['failed','bounced','canceled','suppressed'].includes(e.last_event)), 'Konektag reports success without Resend acceptance');
    }
    return { status: response.status, responseDigest: hash(canonical(body)), asserted: (step.assertions?.length || 0) + (step.oracles?.length || 0), at: new Date().toISOString() };
  };
  const catalogs = JSON.parse(await readFile(path.join(root, 'tests/rest/live/catalog.json'), 'utf8'));
  const inventory = JSON.parse(await readFile(path.join(root, 'docs/rest-test-coverage.json'), 'utf8'));
  const definitions = [];
  for (const file of catalogs.files) definitions.push(...JSON.parse(await readFile(path.join(root, file), 'utf8')));
  const byOperation = new Map(definitions.map(d => [d.operation, d]));
  const save = async () => {
    report.finishedAt = new Date().toISOString();
    report.summary = Object.fromEntries(['PASS','FAIL','BLOCKED','NOT TESTED'].map(s => [s, report.operations.filter(o => o.status === s).length]));
    await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    const rows = report.operations.map(o => `| ${o.operation} | ${o.status} | ${o.scenarios.filter(s=>s.status==='PASS').length}/${o.scenarios.length} | ${o.reason || ''} |`);
    await writeFile(path.join(output, 'results.md'), `# Exécution REST réelle\n\nSource : ${report.sourceHost}. API : ${report.baseUrl}.\n\nPASS signifie que les scénarios écrits passent ; les branches non exercées restent explicites.\n\n| Opération | Résultat | Scénarios passés | Motif |\n|---|---|---|---|\n${rows.join('\n')}\n`, { mode: 0o600 });
  };
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    for (const operation of inventory.operations) {
      const definition = byOperation.get(operation.operation);
      const row = { operation: operation.operation, status: 'NOT TESTED', scenarios: [], baselineBusinessStatus: operation.businessStatus,
        unexercised: definition?.unexercised || [] };
      report.operations.push(row);
      if (!definition || (config.domains?.length && !config.domains.includes(operation.domain)) || interrupted) {
        row.reason = interrupted ? 'Interrupted before operation' : definition ? 'Domain excluded' : 'Existing reviewed tests retained; no live scenario in this campaign'; continue;
      }
      const source = await readFile(path.join(root, definition.source), 'utf8');
      if (createHash('sha256').update(source).digest('hex') !== definition.sourceSha256) {
        row.status = 'BLOCKED'; row.reason = 'Handler changed: re-examine its business scenarios'; continue;
      }
      for (const scenario of definition.scenarios) {
        const result = { name: scenario.name, status: 'BLOCKED', evidence: [] }; row.scenarios.push(result);
        const cleanup = [];
        try {
          if (interrupted) throw new Blocked('Interrupted');
          if (scenario.mode === 'fixture-write' && config.allowFixtureWrites !== true) throw new Blocked('Fixture writes disabled');
          if (scenario.blocked) throw new Blocked(scenario.blocked);
          for (const name of scenario.actors || []) await actor(name);
          for (const dep of scenario.dependencies || []) await dependency(dep);
          await resourceGuard(scenario.resources);
          if (scenario.mode === 'fixture-write' && !scenario.resources?.length && !scenario.actors?.length) throw new Error('Mutation without a test owner forbidden');
          const before = [];
          for (const name of scenario.unchanged || []) before.push(await sql(snapshots[name]));
          for (const precondition of scenario.preconditions || []) {
            const rows = await sql(precondition);
            if ('equals' in precondition && JSON.stringify(rows) !== JSON.stringify(expand(precondition.equals))) throw new Blocked('Fixture state does not match scenario precondition');
            if (precondition.minRows && rows.length < precondition.minRows) throw new Blocked('Required fixture rows missing');
          }
          for (const observation of scenario.read || []) {
            vars[observation.name] = await sql(observation);
            if (observation.minRows && vars[observation.name].length < observation.minRows) throw new Blocked(`Required fixture data missing: ${observation.name}`);
          }
          // Register compensations before the first mutation; captured IDs are resolved during cleanup.
          cleanup.push(...(scenario.cleanup || []));
          for (const step of scenario.steps) result.evidence.push(await request(step));
          for (let i = 0; i < (scenario.unchanged || []).length; i++) assert.deepEqual(await sql(snapshots[scenario.unchanged[i]]), before[i], `Persistent side effect in rejected request: ${scenario.unchanged[i]}`);
          result.status = 'PASS';
        } catch (e) {
          result.status = e instanceof Blocked ? 'BLOCKED' : 'FAIL';
          // Never serialize raw errors: driver/fetch/assertion errors can contain credentials or PII.
          result.reason = e instanceof Blocked ? e.message : 'Business/content/persistence assertion or real dependency request failed';
        } finally {
          for (const compensation of cleanup.reverse()) {
            const outcome = { scenario: scenario.name, status: 'FAIL' };
            try { await request(compensation); outcome.status = 'PASS'; }
            catch (e) { outcome.reason = e instanceof Blocked ? e.message : 'Cleanup failed; inspect fixture-owned records'; result.status = 'FAIL'; }
            report.cleanup.push(outcome);
          }
        }
        await save();
      }
      row.status = row.scenarios.some(s => s.status === 'FAIL') ? 'FAIL' : row.scenarios.some(s => s.status === 'BLOCKED') ? 'BLOCKED' : row.scenarios.length ? 'PASS' : 'BLOCKED';
      if (row.status === 'BLOCKED') row.reason = row.scenarios.find(s => s.status === 'BLOCKED')?.reason || definition.exception;
      await save();
    }
  } finally {
    await save(); await pool?.end(); if (redis?.isOpen) await redis.disconnect();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  console.log(`Rapport privé : ${output}/results.md`);
  if (report.operations.some(o => o.status === 'FAIL') || report.cleanup.some(c => c.status === 'FAIL')) process.exitCode = 1;
  else if (report.operations.some(o => o.status === 'BLOCKED')) process.exitCode = 2;
}
