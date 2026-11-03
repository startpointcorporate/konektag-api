import { createHash } from 'node:crypto';
export const sha256 = text => createHash('sha256').update(text).digest('hex');
export const rank = { uncovered: 0, blocked: 0, partial: 1, covered: 2 };

// Promotion is explicit and reviewable. Text matching only supplies audit candidates.
export function validateReview(review, source, suite) {
  if (sha256(source) !== review.sha256) throw new Error(`Review stale: ${review.file}; re-examine assertions before updating sha256`);
  if (!review.assertions?.length || !review.tests?.length) throw new Error(`Missing assertion evidence: ${review.file}`);
  if (!suite || suite.status !== 'passed') throw new Error(`Reviewed suite not executed successfully: ${review.file}`);
  for (const name of review.tests) {
    const tests = suite.assertionResults.filter(t => t.fullName === name);
    if (!tests.length || tests.some(t => t.status !== 'passed')) throw new Error(`Reviewed test missing, skipped or failed: ${review.file}: ${name}`);
  }
  if (suite.assertionResults.some(t => t.status !== 'passed')) throw new Error(`Skipped/failed tests in reviewed suite: ${review.file}`);
}
export function regressions(before, after) {
  const byKey = new Map(after.map(row => [row.operation, row]));
  return before.flatMap(old => {
    const row = byKey.get(old.operation);
    if (!row) return [`Operation removed from coverage inventory: ${old.operation}`];
    const errors = [];
    if (rank[row.status] < rank[old.status]) errors.push(`Coverage regressed: ${old.operation} (${old.status} -> ${row.status})`);
    if (old.businessStatus === 'covered' && row.businessStatus !== 'covered') errors.push(`Business coverage regressed: ${old.operation}`);
    for (const facet of old.facets || []) if (!row.facets.includes(facet)) errors.push(`Coverage facet removed: ${old.operation}: ${facet}`);
    for (const test of old.tests || []) {
      if (!row.tests.some(t => t.file === test.file && t.name === test.name && t.level === test.level)) errors.push(`Reviewed test removed: ${old.operation}: ${test.file}: ${test.name}`);
    }
    return errors;
  });
}
