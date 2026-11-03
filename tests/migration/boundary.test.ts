import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
function files(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
it('contains no framework, browser entry point, page renderer, or frontend dependency',()=>{
  const pkg=JSON.parse(readFileSync('package.json','utf8'));
  expect(Object.keys({...pkg.dependencies,...pkg.devDependencies}).some(n=>n==='astro'||n.startsWith('@astrojs/'))).toBe(false);
  for(const file of files('src')){
    expect(file).not.toMatch(/\.(astro|css|scss|tsx)$/);
    if(file.endsWith('.ts'))expect(readFileSync(file,'utf8')).not.toMatch(/from\s*['"]astro|import\s*\(['"]astro|\bwindow\.|\bdocument\.(?:createElement|querySelector)|buildMerchantProfileView/);
  }
});
it('never starts background workers from HTTP middleware or bootstrap',()=>{
  for(const file of ['src/api/middleware/security.ts','src/infrastructure/bootstrap.ts'])expect(readFileSync(file,'utf8')).not.toMatch(/startOutboxDispatcher|startAccountingWorker/);
});
