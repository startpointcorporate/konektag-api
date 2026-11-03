import { describe, expect, it } from 'vitest';
import { sha256, validateReview, regressions } from '../../src/infrastructure/scripts/rest-coverage-model.mjs';
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
  it('accepts additive coverage', () => expect(regressions([row],[{...row,facets:['business','validation']}])).toEqual([]));
});
