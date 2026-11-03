import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { routes } from '../../src/api/registry';
it('documents every exported REST operation without inventing routes',()=>{
  const spec=parse(readFileSync('docs/openapi.yaml','utf8'));
  expect(spec.openapi).toBe('3.1.0');
  expect(Object.keys(spec.paths).sort()).toEqual(routes.map(r=>r.path).sort());
  const ids:string[]=[];
  for(const r of routes)for(const method of r.methods){
    const operation=spec.paths[r.path][method.toLowerCase()];expect(operation).toBeDefined();ids.push(operation.operationId);
    for(const key of r.keys)expect(operation.parameters).toContainEqual(expect.objectContaining({name:key,in:'path',required:true}));
  }
  expect(new Set(ids).size).toBe(392);
});
