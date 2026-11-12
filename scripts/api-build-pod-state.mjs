import { readFileSync } from 'node:fs';
import { isDeepStrictEqual as equal } from 'node:util';

// Validate before reusing/deleting the named pod. Kubernetes injects defaults;
// compare the workload and PVC, not server metadata or defaulted fields.
const [manifestPath, podPath, deploymentPath] = process.argv.slice(2);
const desired = JSON.parse(readFileSync(manifestPath, 'utf8'));
const podText = readFileSync(podPath, 'utf8').trim();
const same = (actual, expected, field) => {
  if (!equal(actual, expected)) throw new Error(`Refusing build pod operation: unexpected ${field}`);
};
same(desired.metadata.name, 'konektag-api-setup', 'pod name');
same(desired.metadata.namespace, 'konektag-api', 'namespace');
same(desired.spec.automountServiceAccountToken, false, 'service account token');
same(desired.spec.volumes, [{ name: 'application', persistentVolumeClaim: { claimName: 'konektag-api-code' } }], 'PVC');
if (deploymentPath) {
  const runtime = JSON.parse(readFileSync(deploymentPath, 'utf8')).spec.template.spec;
  same(runtime.nodeSelector, desired.spec.nodeSelector, 'API node selector');
  const mount = runtime.containers.flatMap(c => c.volumeMounts ?? []).find(m => m.mountPath === '/app');
  const volume = runtime.volumes.find(v => v.name === mount?.name);
  same(volume?.persistentVolumeClaim, desired.spec.volumes[0].persistentVolumeClaim, 'API application PVC');
}
if (!podText) { console.log('absent'); process.exit(0); }
const pod = JSON.parse(podText);
same(pod.metadata.name, desired.metadata.name, 'existing pod name');
same(pod.metadata.namespace, desired.metadata.namespace, 'existing namespace');
same(pod.spec.nodeSelector, desired.spec.nodeSelector, 'existing node selector');
same(pod.spec.volumes, desired.spec.volumes, 'existing volumes');
same(pod.spec.automountServiceAccountToken, false, 'existing service account token');
same(pod.spec.restartPolicy, desired.spec.restartPolicy, 'existing restart policy');
same(pod.spec.containers.length, 1, 'container count');
const actual = pod.spec.containers[0], expected = desired.spec.containers[0];
for (const key of ['name', 'image', 'command', 'volumeMounts']) same(actual[key], expected[key], key);
if (actual.env?.length || actual.envFrom?.length || pod.spec.initContainers?.length) {
  throw new Error('Refusing build pod operation: unexpected environment or init containers');
}
if (pod.metadata.deletionTimestamp) console.log('terminating');
else if (['Succeeded', 'Failed'].includes(pod.status.phase)) console.log('stopped');
else console.log('waiting');
