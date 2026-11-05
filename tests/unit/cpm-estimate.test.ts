import {describe,it,expect} from 'vitest';
import {calculateCpmImpressions} from '../../src/application/services/cpm-estimate.ts';
describe('indicative CPM impression range',()=>{
 it('uses conservative high CPM for minimum and low CPM for maximum',()=>{
   expect(calculateCpmImpressions(20000,1000,1500)).toEqual({min:13333,max:20000});
 });
 it('does not round optimistic impressions up',()=>{
   expect(calculateCpmImpressions(1,600,700)).toEqual({min:1,max:1});
 });
 it.each([[0,1,2],[100,0,2],[100,2,1],[100,-1,2],[1.5,1,2],[100,NaN,2]])(
  'rejects invalid estimate inputs',(...args)=>{expect(()=>calculateCpmImpressions(...(args as [number,number,number]))).toThrow('CPM_INVALID_ESTIMATE_INPUT');});
 it('rejects overflow rather than returning a false estimate',()=>{
  expect(()=>calculateCpmImpressions(Number.MAX_SAFE_INTEGER,0.01,0.01)).toThrow('CPM_ESTIMATE_OVERFLOW');
 });
});
