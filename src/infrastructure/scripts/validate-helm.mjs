import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parse, parseAllDocuments } from 'yaml';

const chart = 'src/infrastructure/k8s/konektag-api';
const values = parse(readFileSync(`${chart}/values.yaml`, 'utf8'));
assert.deepEqual(values.workers, { outbox: false, accounting: false });
assert.equal(values.api.enabled, true);
assert.ok(Object.values(values.jobs).every(job => job.enabled === false));
assert.ok(Object.values(values.mcp).every(mcp => mcp.enabled === false));
assert.equal(values.siteApiIngress.enabled, false);
assert.equal(values.ingress.enabled, false);
assert.equal(values.mcpIngress.enabled, false);

const base = [chart, '-f', 'tests/fixtures/helm-values.yaml'];
execFileSync('helm', ['lint', ...base], { stdio: 'inherit' });
function render(overrides = []) {
  return parseAllDocuments(execFileSync('helm', ['template', 'validation', ...base, ...overrides], { encoding: 'utf8' }))
    .map(doc => { assert.equal(doc.errors.length, 0); return doc.toJSON(); }).filter(Boolean);
}
const deployments = docs => docs.filter(doc => doc.kind === 'Deployment').map(doc => doc.metadata.name).sort();
// Every application backend workload must remain on the established VPS 3.
const vps3 = { 'kubernetes.io/hostname': 'konektag-clients' };
const ensurePlacement = docs => {
  const workloadPods = docs.filter(doc => doc.kind === 'Deployment').map(doc => doc.spec.template.spec);
  const scheduledPods = docs.filter(doc => doc.kind === 'CronJob').map(doc => doc.spec.jobTemplate.spec.template.spec);
  for (const pod of [...workloadPods, ...scheduledPods]) assert.deepEqual(pod.nodeSelector, vps3);
};
const defaults = render();
ensurePlacement(defaults);
assert.deepEqual(deployments(defaults), ['validation-api']);
assert.ok(defaults.every(doc => !['CronJob', 'Ingress', 'Secret', 'PersistentVolumeClaim'].includes(doc.kind)));
for (const role of ['outbox', 'accounting']) {
  assert.deepEqual(deployments(render(['--set', `workers.${role}=true`])), ['validation-api', `validation-${role}`].sort());
  const alone = render(['--set', `api.enabled=false,workers.${role}=true`]);
  assert.deepEqual(deployments(alone), [`validation-${role}`]);
  ensurePlacement(alone);
  assert.ok(alone.every(doc => doc.kind !== 'Service'));
}
for (const name of Object.keys(values.mcp)) {
  const docs = render(['--set', `api.enabled=false,mcp.${name}.enabled=true`]);
  assert.deepEqual(deployments(docs), [`validation-mcp-${name}`]);
  ensurePlacement(docs);
  assert.ok(docs.every(doc => !['CronJob', 'Secret', 'PersistentVolumeClaim'].includes(doc.kind)));
  const exposed = render(['--set', `api.enabled=false,mcp.${name}.enabled=true,mcpIngress.enabled=true,mcpIngress.host=mcp.invalid,mcpIngress.tlsSecret=fixture-tls`]);
  const ingressNames = exposed.filter(doc => doc.kind === 'Ingress').map(doc => doc.metadata.name);
  assert.ok(ingressNames.length >= 1);
  ensurePlacement(exposed);
  assert.ok(ingressNames.every(ingress => ingress.startsWith(`validation-mcp-${name}`)));
}
// API-only rendering must not require any MCP Secret/PVC reference.
render(['--set', 'mcp.erpnext.existingSecret=,mcp.erpnext.oauthClaim=,mcp.m365.existingSecret=,mcp.m365.oauthClaim=,mcp.unipile.existingSecret=,mcp.unipile.oauthClaim=']);
const routed = render(['--set', 'siteApiIngress.enabled=true,siteApiIngress.host=www.konektag.eu,siteApiIngress.tlsSecret=fixture-tls,ingress.enabled=true,ingress.host=api.invalid,ingress.tlsSecret=fixture-tls']);
const ingresses = routed.filter(doc => doc.kind === 'Ingress');
assert.equal(ingresses.length, 2);
const site = ingresses.find(doc => doc.metadata.name === 'validation-site-api');
assert.equal(site.spec.ingressClassName, 'traefik');
assert.equal(site.spec.rules[0].host, 'www.konektag.eu');
assert.deepEqual(site.spec.rules[0].http.paths, [{ path: '/api', pathType: 'Prefix', backend: { service: { name: 'validation-api', port: { name: 'http' } } } }]);
assert.equal(site.metadata.annotations, undefined);
assert.ok(routed.every(doc => doc.kind !== 'Middleware'));
const dedicated = ingresses.find(doc => doc.metadata.name === 'validation-api');
assert.equal(dedicated.spec.rules[0].host, 'api.invalid');
assert.ok(dedicated.spec.rules[0].http.paths.some(path => path.path === '/v1'));
for (const ingress of ingresses) assert.ok(ingress.spec.rules[0].http.paths.every(path => !['/', '/g'].includes(path.path)));
assert.ok(render(['--set', 'api.enabled=false,api.existingSecret=']).every(doc => doc.kind !== 'Service'));
console.log('Helm: safe defaults, independent workers/MCP and opt-in Traefik routes validated (offline).');
