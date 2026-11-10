import { describe, expect, it } from 'vitest';
import { sha256, validateReview, validateRetirements, regressions } from '../../src/infrastructure/scripts/rest-coverage-model.mjs';
const source = 'reviewed assertions';
const review = { file: 'example.test.ts', sha256: sha256(source), assertions: ['owner scope and response'], tests: ['creates for the owner'] };
const suite = { status: 'passed', assertionResults: [{ fullName: 'creates for the owner', status: 'passed' }] };
const row = { operation: 'POST /api/example', status: 'covered', businessStatus: 'covered', facets: ['business'], tests: [{file:review.file,name:review.tests[0],level:'unit'}] };
describe('coverage proof and regression guard', () => {
  it('accepts only unchanged reviewed assertions executed successfully', () => expect(() => validateReview(review, source, suite)).not.toThrow());
  it('rejects replacing business assertions with status-only assertions', () => expect(() => validateReview(review, 'expect(response.status).toBe(200)', suite)).toThrow('Review stale'));
  it.each(['pending','todo','failed','skipped'])('rejects %s evidence', status => expect(() => validateReview(review, source, { ...suite, assertionResults: [{ fullName: review.tests[0], status }] })).toThrow());
  it('rejects evidence when only the operation name appears', () => expect(() => validateReview(review, source, {status:'passed',assertionResults:[]})).toThrow('missing'));
  it('rejects an unexecuted reviewed suite', () => expect(() => validateReview(review, source, undefined)).toThrow('not executed'));
  it('rejects removed operations', () => expect(regressions([row],[])).toEqual([expect.stringContaining('removed')]));
  it('rejects a business-to-contract downgrade even if totals remain stable', () => expect(regressions([row],[{...row,status:'partial',businessStatus:'uncovered'}])).toHaveLength(2));
  it('rejects deleted reviewed tests or facets even at the same status', () => expect(regressions([row],[{...row,facets:[],tests:[]}])).toHaveLength(2));
  it('accepts a deleted reviewed test only through an explicit retirement of that exact test', () => {
    const t = row.tests[0];
    const retirement = { operation: row.operation, file: t.file, name: t.name, reason: 'Behaviour retired and proven elsewhere' };
    expect(regressions([row],[{...row,tests:row.tests.slice(1)}],[retirement])).toEqual([]);
    expect(regressions([row],[{...row,tests:row.tests.slice(1)}],[{...retirement,name:'other'}])).toHaveLength(1);
    expect(regressions([row],[{...row,facets:[],tests:row.tests.slice(1)}],[retirement])).toHaveLength(1);
  });
  it('refuses a retirement without reason or for a test that still runs', () => {
    expect(() => validateRetirements([{ operation: 'GET /x', file: 'a.ts', name: 'n', reason: 'short' }], new Set())).toThrow('Invalid');
    expect(() => validateRetirements([{ operation: 'GET /x', file: 'a.ts', name: 'n', reason: 'long enough reason text here' }], new Set(['a.ts::n']))).toThrow('still runs');
  });
  it('accepts additive coverage', () => expect(regressions([row],[{...row,facets:['business','validation']}])).toEqual([]));
});
