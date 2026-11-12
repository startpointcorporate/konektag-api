import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'api-build-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['scripts', 'deploy/k3s']) mkdirSync(join(dir, path), { recursive: true });
  for (const path of ['deploy-api.sh', 'scripts/api-build-pod.sh', 'scripts/api-build-pod-state.mjs', 'deploy/k3s/api-setup.json']) cpSync(join(root, path), join(dir, path));
  const manifest = JSON.parse(readFileSync(join(dir, 'deploy/k3s/api-setup.json')));
  const deployment = { spec: { template: { spec: { nodeSelector: manifest.spec.nodeSelector,
    volumes: manifest.spec.volumes, containers: [{ volumeMounts: manifest.spec.containers[0].volumeMounts }] } } } };
  const pod = { ...structuredClone(manifest), status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
  pod.metadata.uid = 'existing-build-pod';
  const statePath = join(dir, 'state.json'), log = join(dir, 'events.jsonl');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env node
const fs=require('fs');const p=process.env.FAKE_STATE;const s=JSON.parse(fs.readFileSync(p));const cmd=process.argv.slice(3).join(' ');const input=fs.readFileSync(0);fs.appendFileSync(process.env.FAKE_EVENTS,JSON.stringify({cmd,build:input.includes(Buffer.from('npm ci'))})+'\\n');
const save=()=>fs.writeFileSync(p,JSON.stringify(s));const fail=code=>{save();process.exit(code)};
if(cmd.includes('get deployment')) {if(cmd.includes('-o json'))console.log(JSON.stringify(s.deployment));}
else if(cmd.includes('get pod')) {if(s.pod)console.log(JSON.stringify(s.pod));}
else if(cmd.includes('create -f -')) {if(s.pod)fail(1);s.pod=JSON.parse(input);s.pod.metadata.uid='created-pod';s.pod.status={phase:'Pending'};}
else if(cmd.includes('delete pod konektag-api-setup')) {if(s.deleteFailures){s.deleteFailures--;fail(1)}s.pod=null;}
else if(cmd.includes('--for=delete')) {s.pod=null;}
else if(cmd.includes('--for=condition=Ready')) {if(s.failWait)fail(1);s.pod.status={phase:'Running',conditions:[{type:'Ready',status:'True'}]};}
else if(cmd.includes('-- cat /app/active-version')) {console.log(s.active);}
else if(input.includes(Buffer.from('npm ci'))) {if(s.signalBuild){process.kill(process.ppid,'SIGTERM');}if(s.failBuild)fail(23);}
else if(input.includes(Buffer.from('/app/active-version.tmp'))) {s.active=cmd.trim().split(' ').at(-1);}
else if(cmd.includes('-- node - ')) {if(s.failHealth)fail(1);}
else if(!cmd.includes(' exec ')) {throw Error('Unexpected command '+cmd);}
save();
`, { mode: 0o755 });
  // An actual clean, committed checkout satisfies the deployment guard/archive.
  const git = args => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q']); git(['config', 'user.name', 'Deployment test']); git(['config', 'user.email', 'test@example.invalid']);
  // Fixture state and executables must not be archived or violate clean checkout.
  writeFileSync(join(dir, '.gitignore'), 'state.json\nevents.jsonl\nbin/\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']); const sha = git(['rev-parse', 'HEAD']);
  writeFileSync(statePath, JSON.stringify({ deployment, pod: null, active: 'a'.repeat(40), ...options }));
  const env = { ...process.env, PATH: bin+':'+process.env.PATH, FAKE_STATE: statePath, FAKE_EVENTS: log };
  return { pod, sha, state: () => JSON.parse(readFileSync(statePath)), set: data => writeFileSync(statePath, JSON.stringify(data)),
    events: () => { try { return readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } },
    run: (action='deploy') => spawnSync('bash', action==='deploy'?['deploy-api.sh']:['scripts/api-build-pod.sh', action], { cwd:dir, env, encoding:'utf8', timeout:15000 }) };
}
const noPVCDeletion = f => assert(!f.events().some(x => /delete.*(?:pvc|persistentvolume)/.test(x.cmd)));

test('missing pod is provisioned from manifest, becomes ready and cleanup preserves PVC', t => {
  const f=fixture(t); assert.equal(f.run('ensure').status,0); assert.equal(f.state().pod.status.phase,'Running');
  assert.equal(f.state().pod.spec.volumes[0].persistentVolumeClaim.claimName,'konektag-api-code');
  assert.equal(f.run('cleanup').status,0); assert.equal(f.state().pod,null);noPVCDeletion(f);
});
test('operational existing pod is reused without creation or replacement', t => {
  const f=fixture(t); f.set({...f.state(),pod:f.pod});assert.equal(f.run('ensure').status,0);
  assert.equal(f.state().pod.metadata.uid,'existing-build-pod');assert(!f.events().some(x=>/create -f|delete pod/.test(x.cmd)));
});
for(const phase of ['Failed','Succeeded'])test('stopped '+phase+' pod is replaced', t=>{
  const f=fixture(t);const pod=f.pod;pod.status.phase=phase;f.set({...f.state(),pod});assert.equal(f.run('ensure').status,0);
  assert.equal(f.state().pod.metadata.uid,'created-pod');noPVCDeletion(f);
});
test('terminating pod is awaited before replacement',t=>{
  const f=fixture(t);const pod=f.pod;pod.metadata.deletionTimestamp='2026-01-01T00:00:00Z';f.set({...f.state(),pod});assert.equal(f.run('ensure').status,0);
  assert(f.events().some(x=>x.cmd.includes('--for=delete')));assert.equal(f.state().pod.metadata.uid,'created-pod');
});
test('existing pod with another PVC is neither reused nor deleted',t=>{
  const f=fixture(t);const pod=f.pod;pod.spec.volumes[0].persistentVolumeClaim.claimName='another-volume';f.set({...f.state(),pod});
  assert.notEqual(f.run('ensure').status,0);assert.notEqual(f.run('cleanup').status,0);assert(!f.events().some(x=>/create -f|delete pod/.test(x.cmd)));
});
test('deployment/PVC mismatch fails before creation',t=>{
  const f=fixture(t);const s=f.state();s.deployment.spec.template.spec.volumes[0].persistentVolumeClaim.claimName='unexpected';f.set(s);
  assert.notEqual(f.run('ensure').status,0);assert(!f.events().some(x=>x.cmd.includes('create -f')));
});
test('cleanup is idempotent when pod is already absent',t=>{
  const f=fixture(t);assert.equal(f.run('cleanup').status,0);assert.equal(f.run('cleanup').status,0);assert(!f.events().some(x=>x.cmd.includes('delete')));
});
test('successful deployment keeps existing build/activation, then removes technical pod',t=>{
  const f=fixture(t);const r=f.run();assert.equal(r.status,0,r.stderr);assert.equal(f.state().active,f.sha);assert.equal(f.state().pod,null);
  assert(f.events().some(x=>x.build));noPVCDeletion(f);
});
test('failed build keeps previous release, cleans pod and retains original error status',t=>{
  const f=fixture(t,{failBuild:true});const r=f.run();assert.equal(r.status,23,r.stderr);assert.equal(f.state().active,'a'.repeat(40));assert.equal(f.state().pod,null);noPVCDeletion(f);
});
test('readiness failure also cleans the newly created pod',t=>{
  const f=fixture(t,{failWait:true});assert.notEqual(f.run().status,0);assert.equal(f.state().pod,null);assert.equal(f.state().active,'a'.repeat(40));
});
test('failed health check rolls back and then cleans the pod',t=>{
  const f=fixture(t,{failHealth:true});const r=f.run();assert.notEqual(r.status,0);assert.equal(f.state().active,'a'.repeat(40));assert.equal(f.state().pod,null);noPVCDeletion(f);
});
test('TERM during build exits 143 and cleans the pod',t=>{
  const f=fixture(t,{signalBuild:true});const r=f.run();assert.equal(r.status,143,r.stderr);assert.equal(f.state().pod,null);
});
test('already-active release does not build and cleans a leftover matching pod',t=>{
  const f=fixture(t);f.set({...f.state(),active:f.sha,pod:f.pod});assert.equal(f.run().status,0);assert.equal(f.state().pod,null);assert(!f.events().some(x=>x.build));
});
test('recoverable cleanup failure keeps original build error; fallback cleanup succeeds',t=>{
  const f=fixture(t,{failBuild:true,deleteFailures:1});assert.equal(f.run().status,23);assert(f.state().pod);
  assert.equal(f.run('cleanup').status,0);assert.equal(f.state().pod,null);noPVCDeletion(f);
});
