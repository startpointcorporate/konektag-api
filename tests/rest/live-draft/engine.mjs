import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('HTTP(S) API origin required');
  const fixture = JSON.parse(await readFile(path.resolve(path.dirname(configFile), config.fixtures), 'utf8'));
  const vars = { ...fixture.actors, ...fixture.resources, ...fixture.vars, cases: fixture.cases || {}, run: { id: `rest-test-${randomUUID()}` }, captured: {} };
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
  // Reuse the API pod's existing DATABASE_URL. No local credentials or SSH tunnel.
  const observeFromExistingPod = async query => {
    const observer = config.postgresql?.k3sExec;
    const host = observer?.sshHost || 'konektag-core';
    const namespace = observer?.namespace || 'konektag-api';
    const deployment = observer?.deployment || 'konektag-api';
    for (const value of [host, namespace, deployment]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error('Invalid K3s observer name');
    }
    const remoteCode = `import fs from 'node:fs';
import pg from 'pg';
const descriptor=JSON.parse(fs.readFileSync(0,'utf8'));
if(!/^\\s*(SELECT|WITH)\\b/i.test(descriptor.sql)||descriptor.sql.includes(';')) throw Error('Read-only SELECT required');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
try {const client=await pool.connect();try{await client.query('BEGIN READ ONLY');const result=await client.query(descriptor.sql,descriptor.params||[]);await client.query('COMMIT');console.log(JSON.stringify(result.rows));}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}}finally{await pool.end();}`;
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = `sudo k3s kubectl -n ${namespace} exec -i deployment/${deployment} -- node --input-type=module -e ${quote(remoteCode)}`;
    return await new Promise((resolve, reject) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, command],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout='', stderr='';
      const timer=setTimeout(()=>child.kill(),30000);
      child.stdout.on('data', chunk => { stdout+=chunk; if(stdout.length>4000000) child.kill(); });
      child.stderr.on('data', chunk => { stderr+=chunk; if(stderr.length>4000) child.kill(); });
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        if (code!==0) return reject(new Blocked('Existing K3s PostgreSQL observer failed: '+stderr.slice(0,250)));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid PostgreSQL observer response')); }
      });
      child.stdin.end(JSON.stringify(query));
    });
  };
  const remoteSql = config.postgresql?.k3sExec === true || typeof config.postgresql?.k3sExec === 'object';
  const pool = !remoteSql && config.postgresql?.urlEnv && process.env[config.postgresql.urlEnv]
    ? new pg.Pool({ connectionString: process.env[config.postgresql.urlEnv], max: 1, connectionTimeoutMillis: 8000,
      statement_timeout: 10000, options: '-c default_transaction_read_only=on',
      ...(config.postgresql.caEnv ? { ssl: { ca: requiredEnv(config.postgresql.caEnv), rejectUnauthorized: true } } : {}) }) : null;
  let redis;
  const report = { schemaVersion: 1, execution: 'EXECUTED', startedAt: new Date().toISOString(), sourceHost: hostname(),
    baseUrl: base.origin, runId: vars.run.id, operations: [], dependencies: { status: 'NOT VALIDATED', manifest: 'tests/rest/live-draft/dependencies.json' }, cleanup: [], requests: 0 };
  const output = path.resolve(config.outputDirectory || 'work/rest-live-results', vars.run.id);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const sql = async descriptor => {
    if (!pool && !remoteSql) throw new Blocked('PostgreSQL observer connection unavailable');
    const q = expand(descriptor);
    if (!/^\s*(SELECT|WITH)\b/i.test(q.sql) || q.sql.includes(';')) throw new Error('Only single read-only observer SQL statements allowed');
    if (remoteSql) return JSON.parse(JSON.stringify(await observeFromExistingPod(q)));
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
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Provider HTTP(S) required');
    return fetch(u, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  };
  function check(body, assertions) {
    for (const a of assertions) {
      const value = at(body, a.path);
      if ('equals' in a) {
        if (typeof a.equals === 'string' && value !== a.equals) {
          const safeActual = typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : '(redacted)';
          throw new Error(`ASSERTION_MISMATCH path=${a.path} expected=${JSON.stringify(a.equals)} actual=${safeActual}`);
        }
        if (typeof a.equals !== 'string') assert.deepEqual(value, a.equals, a.path);
      }
      if ('subset' in a) subset(value, a.subset);
      if ('contains' in a) { assert.ok(Array.isArray(value), a.path); assert.ok(value.some(item => { try { subset(item, a.contains); return true; } catch { return false; } }), a.path); }
      if ('excludes' in a) { assert.ok(Array.isArray(value), a.path); assert.ok(!value.some(item => { try { subset(item, a.excludes); return true; } catch { return false; } }), a.path); }
      if (a.type) assert.ok(a.type === 'array' ? Array.isArray(value) : a.type === 'integer' ? Number.isSafeInteger(value) : typeof value === a.type, a.path);
      if ('min' in a) assert.ok(value >= a.min, a.path);
      if ('max' in a) assert.ok(value <= a.max, a.path);
      if (a.matches) assert.match(value, new RegExp(a.matches), a.path);
      if (a.isoCountryOrNull) assert.ok(value === null || (typeof value === 'string' && /^[A-Z]{2}$/.test(value)), a.path);
      if (a.absent) assert.equal(value, undefined, a.path);
    }
  }
  const verifiedActors = new Set();
  const actor = async name => {
    if (!name) return {};
    const identity = fixture.actors?.[name];
    if (!identity?.testOnly || !identity.username || !identity.tokenEnv) throw new Blocked(`Existing test account required: ${name}`);
    const token = requiredEnv(identity.tokenEnv);
    if (!verifiedActors.has(name)) {
      // The JWT is only decoded locally for a subject check; API verifies signature and expiry.
      let subject;
      try { subject = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; } catch {}
      if (!subject) throw new Blocked(`Valid Keycloak user token required: ${name}`);
      if (identity.keycloakId && subject !== identity.keycloakId) throw new Blocked(`Token subject mismatch: ${name}`);
      const users = await sql({ sql: 'SELECT id,keycloak_id,username,role FROM konektag.users WHERE username=$1 AND deleted_at IS NULL', params: [identity.username] });
      if (users.length !== 1 || users[0].keycloak_id !== subject || (identity.userId && users[0].id !== identity.userId) || (identity.role && users[0].role !== identity.role)) {
        throw new Blocked(`Keycloak token/SQL account mismatch: ${name}`);
      }
      Object.assign(identity, { userId: users[0].id, keycloakId: users[0].keycloak_id, role: users[0].role });
      vars[name] = { ...identity }; verifiedActors.add(name);
    }
    return identity.auth === 'cookie' ? { Cookie: `konektag_access_token=${token}` } : { Authorization: `Bearer ${token}` };
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
  const { guards, snapshots } = JSON.parse(await readFile(path.join(root, 'tests/rest/live-draft/oracles.json'), 'utf8'));
  const request = async step => {
    const headers = { ...(await actor(step.actor)), ...(step.internalToken ? { Authorization: `Bearer ${requiredEnv(config.internalTokenEnv)}` } : {}) };
    const { oracles: deferredOracles, ...httpStep } = step;
    const expanded = expand(httpStep);
    const target = new URL(expanded.path, base);
    if (target.origin !== base.origin || target.username || target.password || !target.pathname.startsWith('/')) throw new Error('Cross-origin request forbidden');
    const init = { method: expanded.method, headers: { ...headers, ...expanded.headers, ...Object.fromEntries(Object.entries(expanded.headerEnv || {}).map(([key, env]) => [key, requiredEnv(env)])) }, redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs || 15000) };
    if (!['GET', 'HEAD'].includes(init.method) && !init.headers['X-Idempotency-Key'] && !init.headers['Idempotency-Key']) init.headers['X-Idempotency-Key'] = `${vars.run.id}-${randomUUID()}`;
    if (expanded.origin !== false) init.headers.Origin = base.origin;
    if ('body' in expanded) { init.headers['Content-Type'] ||= 'application/json'; init.body = JSON.stringify(expanded.body); }
    if ('raw' in expanded) { init.headers['Content-Type'] ||= 'application/json'; init.body = expanded.raw; }
    if ('form' in expanded) {
      delete init.headers['Content-Type'];
      init.body = new FormData();
      for (const [key, value] of Object.entries(expanded.form)) {
        if (value && typeof value === 'object' && value.file) {
          const filename = path.resolve(path.dirname(configFile), value.file);
          init.body.set(key, new Blob([await readFile(filename)], { type: value.type || 'application/octet-stream' }), path.basename(filename));
        } else init.body.set(key, String(value));
      }
    }
    if (expanded.resendEvidence && !config.resend?.testRecipients?.includes(expanded.resendEvidence)) throw new Blocked('Test email recipient allowlist required before sending');
    report.requests++;
    const response = await fetch(target, init);
    if (response.status === 401 && expanded.status !== 401
      && !Object.keys(init.headers).some(k => /^(authorization|cookie|x-api-key)$/i.test(k))) {
      throw new Blocked('AUTH_REQUIRED: protected endpoint needs an authenticated test actor');
    }
    if (response.status !== expanded.status) {
      const actualCode = await response.clone().json().then(v => v?.error).catch(() => null);
      const safeCode = typeof actualCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(actualCode) ? ` error=${actualCode}` : '';
      throw new Error(`HTTP_STATUS expected=${expanded.status} actual=${response.status}${safeCode}`);
    }
    let body = null; // 204/303 have no body; keep a deterministic, hashable evidence value.
    if (expanded.sse) {
      assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
      const reader = response.body.getReader(); let text = '';
      try { while (!text.includes('\n\n')) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); text = text.replaceAll('\r\n', '\n'); if (text.length > 65536) throw new Error('SSE frame too large'); } }
      finally { await reader.cancel(); }
      assert.equal(/^event: (.*)$/m.exec(text)?.[1], expanded.sse === true ? 'status_update' : expanded.sse); body = JSON.parse(/^data: (.*)$/m.exec(text)?.[1] || '{}');
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
    for (const [k, v] of Object.entries(expanded.responseHeaders || {})) {
      if (!new RegExp(v).test(response.headers.get(k) || '')) throw new Error(`HTTP_HEADER_MISMATCH: ${k}, status=${response.status}`);
    }
    for (const [name, pointer] of Object.entries(expanded.capture || {})) {
      const value = at(body, pointer); assert.notEqual(value, undefined, 'capture missing'); vars.captured[name] = value;
    }
    for (const oracle of deferredOracles || []) {
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
    if (expanded.valkeyOtp) {
      if (!redis) {
        redis = createClient({ url: requiredEnv(config.valkey?.urlEnv), socket: { connectTimeout: 8000, reconnectStrategy: false } });
        redis.on('error', () => {});
        await redis.connect();
      }
      const email = expanded.valkeyOtp.trim().toLowerCase();
      assert.match(await redis.get(`otp:${email}`) || '', /^\d{6}$/);
      assert.ok(await redis.ttl(`otp:${email}`) > 0, 'Expiring OTP');
      assert.equal(await redis.get(`otp:attempts:${email}`), '0');
    }
    if (step.resendEvidence) {
      const email = expand(step.resendEvidence);
      if (!config.resend.testRecipients.includes(email)) throw new Error('Email recipient outside test allowlist');
      // Resend's own event log is the oracle; HTTP 200 from Konektag is insufficient.
      const response = await serviceFetch(`${config.resend.baseUrl || 'https://api.resend.com'}/emails`, { headers: { Authorization: `Bearer ${requiredEnv(config.resend.apiKeyEnv)}` } });
      assert.equal(response.status, 200); const log = await response.json();
      assert.ok(log.data.some(e => (Array.isArray(e.to) ? e.to : [e.to]).includes(email) && Date.parse(e.created_at) >= Date.parse(report.startedAt)
        && !['failed','bounced','canceled','suppressed'].includes(e.last_event)), 'Konektag reports success without Resend acceptance');
    }
    return { status: response.status, responseDigest: hash(canonical(body)), asserted: (step.assertions?.length || 0) + (step.oracles?.length || 0), at: new Date().toISOString() };
  };
  const catalogs = JSON.parse(await readFile(path.join(root, 'tests/rest/live-draft/catalog.json'), 'utf8'));
  const definitions = [];
  for (const file of catalogs.files) definitions.push(...JSON.parse(await readFile(path.join(root, file), 'utf8')));
  const inventory = { operations: definitions.map(d => ({ operation: d.operation, domain: d.domain })) };
  assert.equal(definitions.length, catalogs.operations, 'Catalog size');
  assert.equal(new Set(definitions.map(d => d.operation)).size, definitions.length, 'Duplicate operation');
  for (const d of definitions) assert.equal(d.scenarios.length, 1, 'Exactly one scenario per operation');
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
    const campaignStartedAt = Date.now();
    const selectedOperations = config.operations?.length ? inventory.operations.filter(o => config.operations.includes(o.operation)) : inventory.operations;
    const totalOperations = selectedOperations.length;
    let completedOperations = 0;
    console.log(`[REST LIVE] Début : ${totalOperations} opérations | ${report.baseUrl}`);
    const announceEnd = (row, startedAt) => {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      completedOperations++;
      const reason = row.status === 'BLOCKED' ? ` | ${row.reason || 'Prérequis manquant'}`
        : row.status === 'FAIL' ? ` | ${row.scenarios?.find(s => s.status === 'FAIL')?.reason || row.reason || 'Échec à analyser'}`
        : '';
      console.log(`[REST LIVE ${completedOperations}/${totalOperations}] ${row.status.padEnd(10)} ${row.operation} (${elapsed}s)${reason}`);
      if (completedOperations % 25 === 0 || completedOperations === totalOperations) {
        const counts = Object.fromEntries(['PASS','FAIL','BLOCKED','NOT TESTED'].map(k => [k, report.operations.filter(o => o.status === k).length]));
        console.log(`[REST LIVE] Progression ${completedOperations}/${totalOperations} | ${JSON.stringify(counts)} | durée totale ${Math.round((Date.now() - campaignStartedAt)/1000)}s`);
      }
    };
    for (const operation of selectedOperations) {
      const operationStartedAt = Date.now();
      console.log(`[REST LIVE ${completedOperations + 1}/${totalOperations}] START ${operation.operation}`);
      const definition = byOperation.get(operation.operation);
      const row = { operation: operation.operation, status: 'NOT TESTED', scenarios: [], baselineBusinessStatus: operation.businessStatus,
        unexercised: definition?.unexercised || [] };
      report.operations.push(row);
      if (!definition || (config.operations?.length && !config.operations.includes(operation.operation)) || (config.domains?.length && !config.domains.includes(operation.domain)) || interrupted) {
        row.reason = interrupted ? 'Interrupted before operation' : definition ? 'Domain excluded' : 'Existing reviewed tests retained; no live scenario in this campaign'; announceEnd(row, operationStartedAt); continue;
      }
      const source = await readFile(path.join(root, definition.source), 'utf8');
      if (createHash('sha256').update(source).digest('hex') !== definition.sourceSha256) {
        row.status = 'BLOCKED'; row.reason = 'Handler changed: re-examine its business scenarios'; announceEnd(row, operationStartedAt); continue;
      }
      for (const template of definition.scenarios) {
        try {
          let scenario = template;
          if (template.fixtureCase) {
            const binding = fixture.cases?.[template.fixtureCase];
            if (!binding || !binding.testOnly || !binding.owner || !binding.request || !binding.expected) {
              row.status = 'BLOCKED'; row.reason = `Fixture required: cases.${template.fixtureCase}`; break;
            }
            const { request: input, expected } = binding;
            const httpActor = binding.actor === false ? undefined : (binding.actor || binding.owner);
            if (!Number.isInteger(expected.status) || expected.status < 200 || expected.status >= 300
              || (expected.status !== 204 && (expected.body === undefined || (expected.body && typeof expected.body === 'object' && !Object.keys(expected.body).length)))
              || (definition.method !== 'GET' && (!binding.oracles?.length || binding.oracles.some(o => !('equals' in o) && !o.assertions && o.responsePath === undefined)))) {
              row.status = 'BLOCKED'; row.reason = 'Business response content and mutation persistence oracle required'; break;
            }
            const params = expand(input.params || {});
            const target = definition.path.replace(/\{([^}]+)\}/g, (_, key) => {
              if (typeof params[key] !== 'string' || !params[key]) throw new Blocked(`Path parameter required: ${key}`);
              return encodeURIComponent(params[key]);
            });
            const query = new URLSearchParams(input.query || {}).toString();
            scenario = { ...template, actors: httpActor ? [httpActor] : [], resources: [],
              mode: 'fixture-write', preconditions: binding.preconditions || [],
              cleanup: binding.cleanup || [], steps: [{ ...input, actor: httpActor,
                method: definition.method, path: target + (query ? `?${query}` : ''),
                status: expected.status, assertions: expected.status === 204 ? [] : [{ path: '', subset: expected.body }], oracles: binding.oracles || [] }] };
            // Public mutations still need an explicitly designated test owner.
            scenario.actors = binding.owner ? [...new Set([...scenario.actors, binding.owner])] : scenario.actors;
          }
          const result = { name: scenario.name, status: 'BLOCKED', evidence: [] }; row.scenarios.push(result);
          const cleanup = [];
          try {
            if (interrupted) throw new Blocked('Interrupted');
            if (scenario.mode === 'fixture-write' && config.allowFixtureWrites !== true) throw new Blocked('Fixture writes disabled');
            if (scenario.blocked) throw new Blocked(scenario.blocked);
            for (const name of scenario.actors || []) await actor(name);
            // Dependencies are source-derived metadata, never health probes.
            row.dependencies = definition.dependencies;
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
            result.reason = e instanceof Blocked ? e.message
              : /^(HTTP_STATUS(?:\s|$)|HTTP_HEADER_MISMATCH\b|ASSERTION_MISMATCH\b)/.test(e?.message || '') ? e.message
              : 'Business/content/persistence assertion or real dependency request failed';
          } finally {
            for (const compensation of cleanup.reverse()) {
              const outcome = { scenario: scenario.name, status: 'FAIL' };
              try { await request(compensation); outcome.status = 'PASS'; }
              catch (e) { outcome.reason = e instanceof Blocked ? e.message : 'Cleanup failed; inspect fixture-owned records'; result.status = 'FAIL'; }
              report.cleanup.push(outcome);
            }
          }
          await save();
        } catch (e) {
          row.scenarios.push({ name: template.name, status: e instanceof Blocked ? 'BLOCKED' : 'FAIL',
            reason: e instanceof Blocked ? e.message : 'Invalid fixture binding', evidence: [] });
        }
      }
      if (!row.scenarios.length && row.status === 'BLOCKED') { await save(); announceEnd(row, operationStartedAt); continue; }
      row.status = row.scenarios.some(s => s.status === 'FAIL') ? 'FAIL' : row.scenarios.some(s => s.status === 'BLOCKED') ? 'BLOCKED' : row.scenarios.length ? 'PASS' : 'BLOCKED';
      if (row.status === 'BLOCKED') row.reason = row.scenarios.find(s => s.status === 'BLOCKED')?.reason || definition.exception;
      await save();
      announceEnd(row, operationStartedAt);
    }
  } finally {
    await save(); await pool?.end(); if (redis?.isOpen) await redis.disconnect();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  console.log(`Rapport privé : ${output}/results.md`);
  if (report.operations.some(o => o.status === 'FAIL') || report.cleanup.some(c => c.status === 'FAIL')) process.exitCode = 1;
  else if (report.operations.some(o => o.status === 'BLOCKED' || o.status === 'NOT TESTED')) process.exitCode = 2;
}
