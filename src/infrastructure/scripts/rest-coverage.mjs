import ts from 'typescript';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { execFileSync } from 'node:child_process';
import { validateReview, validateRetirements, regressions } from './rest-coverage-model.mjs';
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const reportPath = option('--results', 'work/rest-results.json');
const check = args.includes('--check');
const spec = parse(await readFile('docs/openapi.yaml', 'utf8'));
const routeRecords = JSON.parse(await readFile('docs/routes.json', 'utf8'));
const results = JSON.parse(await readFile(reportPath, 'utf8'));
if (!results.success || results.numFailedTests || results.numPendingTests || results.numTodoTests) throw new Error('Coverage requires a successful run without skipped/todo tests');
const relative = file => path.relative(process.cwd(), file).replaceAll('\\', '/');
const suites = new Map(results.testResults.map(s => [relative(s.name), s]));
const reviews = JSON.parse(await readFile('tests/rest/coverage-reviews.json', 'utf8'));
const methods = new Set(['get','post','put','patch','delete','head','options','trace']);
const operations = Object.entries(spec.paths).flatMap(([url,item]) => Object.entries(item).filter(([method]) => methods.has(method)).map(([method,op]) => ({
  operation: `${method.toUpperCase()} ${url}`, domain: op.tags?.[0] || 'legacy', method: method.toUpperCase(), path: url, source: op['x-source'],
  status: 'uncovered', businessStatus: 'uncovered', facets: [], levels: [], tests: [], assertions: [], candidates: [], constraints: [],
}))).sort((a,b) => a.operation.localeCompare(b.operation));
const byKey = new Map(operations.map(op => [op.operation, op]));
const expected = routeRecords.flatMap(r => r.methods.map(m => `${m} ${r.path}`)).sort();
if (JSON.stringify([...byKey.keys()].sort()) !== JSON.stringify(expected)) throw new Error('OpenAPI/route operation inventory differs; run npm run docs:generate');
async function walk(dir) { return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : `${dir}/${e.name}`))).flat(); }
const files = (await walk('tests')).filter(f => /\.test\.[cm]?[jt]s$/.test(f));
const sources = new Map(await Promise.all(files.map(async f => [f, await readFile(f,'utf8')])));
// Imports (including dynamic imports) identify candidates only. No test name/path grep can promote coverage.
for (const [file,code] of sources) {
  const ast = ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true);
  function visit(node) {
    let module, imported;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      module = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) imported = bindings.elements.map(e => (e.propertyName || e.name).text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) module = node.arguments[0].text;
    if (module?.includes('/api/routes/')) {
      const source = path.normalize(path.join(path.dirname(file), module)).replace(/\.ts$/, '') + '.ts';
      for (const op of operations.filter(o => o.source === source && (!imported || imported.includes(o.method)))) if (!op.candidates.includes(file)) op.candidates.push(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
for (const review of reviews) {
  if (args.includes('--audit-before') && review.file.startsWith('tests/rest/')) continue;
  validateReview(review, sources.get(review.file) || '', suites.get(review.file));
  for (const key of review.operations) {
    const op = byKey.get(key); if (!op) throw new Error(`Review references unknown operation: ${key}`);
    op.tests.push(...review.tests.map(name => ({ file: review.file, name, level: review.level })));
    op.assertions.push(...review.assertions);
    op.facets.push(...review.facets); op.levels.push(review.level);
    if (review.status === 'covered') { op.status = 'covered'; op.businessStatus = 'covered'; }
    else if (op.status !== 'covered') op.status = review.status;
    op.constraints.push(...(review.constraints || []));
  }
}
const transportFile = 'tests/rest/operations.test.ts';
const transportSuite = suites.get(transportFile);
if (!args.includes('--audit-before')) {
  const proof = JSON.parse(await readFile('tests/rest/coverage-contract-review.json', 'utf8'));
  validateReview({ ...proof, tests: transportSuite?.assertionResults.map(t => t.fullName) || [] }, sources.get(transportFile) || '', transportSuite);
}
for (const op of operations) {
  for (const kind of ['TRANSPORT','AUTH']) {
    const marker = `[REST ${kind} ${op.operation}]`;
    const tests = transportSuite?.assertionResults.filter(t => t.title.startsWith(marker)) || [];
    // --audit-before deliberately uses the original run, before generated tests existed.
    if (!tests.length && args.includes('--audit-before')) continue;
    if (tests.length !== 1 || tests[0].status !== 'passed') throw new Error(`Generated operation test missing/skipped/failed: ${marker}`);
    op.tests.push({ file: transportFile, name: tests[0].fullName, level: 'contract' });
    op.assertions.push(...( kind === 'AUTH' ? ['credential refusal', 'no database or handler execution'] : ['routing and dynamic parameters', 'raw body, query and cookie preservation']));
    op.facets.push(kind.toLowerCase()); op.levels.push('contract');
    if (op.status === 'uncovered') op.status = 'partial';
  }
  if (op.businessStatus !== 'covered' && !op.constraints.length) op.constraints.push('Business success/validation/effects not yet verified at this REST boundary; contract/credential tests are insufficient.');
  op.assertions = [...new Set(op.assertions)];
  op.facets = [...new Set(op.facets)].sort(); op.levels = [...new Set(op.levels)].sort(); op.candidates.sort(); op.constraints = [...new Set(op.constraints)];
}
const summary = { paths: Object.keys(spec.paths).length, operations: operations.length,
  covered: operations.filter(o => o.status === 'covered').length, partial: operations.filter(o => o.status === 'partial').length,
  blocked: operations.filter(o => o.status === 'blocked').length, uncovered: operations.filter(o => o.status === 'uncovered').length,
  businessUncovered: operations.filter(o => o.businessStatus !== 'covered').length,
  executedTests: results.numTotalTests, passedTests: results.numPassedTests,
};
const report = { schemaVersion: 1, summary, operations };
const jsonPath = option('--output', 'docs/rest-test-coverage.json');
const markdownPath = jsonPath.replace(/\.json$/, '.md');
const markdown = `# REST test coverage\n\nGenerated by \`npm run test:rest:coverage\`. See [audit and limitations](rest-test-audit.md).\n\n${summary.paths} paths / ${summary.operations} HTTP operations. Covered: ${summary.covered}; partial: ${summary.partial}; blocked: ${summary.blocked}; uncovered: ${summary.uncovered}. **${summary.businessUncovered} operations still lack reviewed business coverage.** ${summary.passedTests}/${summary.executedTests} tests passed.\n\nCovered means a reviewed functional slice with non-status assertions, not exhaustive branch coverage or live-provider E2E certification. Partial includes transport and credential rejection only. Blocked identifies an observed defect or a documented external dependency. Candidates from imports are never counted as proof.\n\n| Domain | Method | Path | Status / business | Levels | Evidence / constraints |\n| --- | --- | --- | --- | --- | --- |\n` + operations.map(op => `| ${op.domain} | ${op.method} | \`${op.path}\` | ${op.status} / ${op.businessStatus} | ${op.levels.join(', ')} | ${[...new Set(op.tests.map(t => t.file))].map(f => `[${f}](../${f})`).join(', ')}${op.constraints.length ? '<br>' + op.constraints.join(' ') : ''} |`).join('\n') + '\n';
if (!args.includes('--audit-before')) {
  let baseline;
  const ref = option('--baseline-ref', null);
  if (ref) {
    // Missing baseline is allowed only when introducing the tool for the first time.
    const listing = execFileSync('git',['ls-tree','--name-only',ref,'docs/rest-test-coverage.json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    if (listing) baseline = JSON.parse(execFileSync('git',['show',`${ref}:docs/rest-test-coverage.json`],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  }
  baseline ??= JSON.parse(await readFile('docs/rest-test-baseline.json','utf8'));
  const retirements = JSON.parse(await readFile('tests/rest/coverage-retirements.json', 'utf8').catch(() => '[]'));
  validateRetirements(retirements, new Set([...suites].flatMap(([file, suite]) => suite.assertionResults.map(t => `${file}::${t.fullName}`))));
  const errors = regressions(baseline.operations, operations, retirements); if (errors.length) throw new Error(errors.join('\n'));
}
for (const [file, text] of [[jsonPath,JSON.stringify(report,null,2)+'\n'],[markdownPath,markdown]]) {
  if (check) { if (await readFile(file,'utf8') !== text) throw new Error(`Stale coverage report: ${file}; run npm run test:rest:coverage`); }
  else await writeFile(file,text);
}
console.log(JSON.stringify(summary));
