import { expect, vi } from 'vitest';
import { createContext, type RouteHandler } from '../../../src/api/http';
export const actor = '11111111-1111-4111-8111-111111111111';
export const id = '22222222-2222-4222-8222-222222222222';
export const other = '33333333-3333-4333-8333-333333333333';
type Result = { rows: any[]; rowCount: number };
type Rule = { sql: RegExp; run: (values: any[], sql: string) => Result | Promise<Result>; once: boolean };
const rules: Rule[] = [];
export const db = {
  role: 'admin' as string | null,
  query: vi.fn(async (sql: string, values: any[] = []): Promise<Result> => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT role FROM konektag.users WHERE id/.test(sql)) return { rows: db.role ? [{ role: db.role }] : [], rowCount: db.role ? 1 : 0 };
    const index = rules.findIndex(r => r.sql.test(sql));
    if (index < 0) throw new Error(`UNEXPECTED_SQL: ${sql}`);
    const rule = rules[index]; if (rule.once) rules.splice(index,1);
    // Detect bad bindings rather than accepting SQL that PostgreSQL would reject.
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]));
    if (Math.max(0,...placeholders) !== values.length) throw new Error(`SQL_BINDING_MISMATCH: ${sql}`);
    return rule.run(values,sql);
  }),
  connect: vi.fn(async () => ({ query: db.query, release: db.release })),
  release: vi.fn(),
};
export function reset() { vi.clearAllMocks(); rules.length = 0; db.role = 'admin'; vi.stubGlobal('fetch',vi.fn(() => { throw new Error('UNEXPECTED_EXTERNAL_NETWORK'); })); }
export function sql(pattern: RegExp, rows: any[] = [], inspect?: (values: any[], query: string) => void, rowCount = rows.length) {
  rules.push({ sql: pattern, once: true, run: (values,query) => { inspect?.(values,query); return { rows, rowCount }; } });
}
export function failure(pattern: RegExp, error: Error) { rules.push({sql:pattern,once:true,run:()=>{throw error;}}); }
export function consumed() { expect(rules.map(r=>String(r.sql))).toEqual([]); }
export function writes() { return db.query.mock.calls.filter(([q])=>/^\s*(INSERT|UPDATE|DELETE)/.test(q)); }
export async function call(source: string, method: string, body?: unknown, options: { signedIn?: boolean; query?: string; params?: Record<string,string>; raw?: string; headers?: Record<string,string>; user?: Record<string,unknown> } = {}) {
  const handler = (await import('../../../src/api/routes/'+source+'.ts'))[method] as RouteHandler;
  expect(vi.isMockFunction(handler)).toBe(false);
  const request = new Request('https://api.invalid/api/test'+(options.query || ''), {method,headers:{'content-type':'application/json',...options.headers},
    ...(['GET','HEAD'].includes(method)?{}:{body:options.raw ?? JSON.stringify(body??{})})});
  const c=createContext(request,options.params??{id});
  if(options.signedIn!==false)c.locals.user={id:actor,keycloak_id:'kc-owner',role:'admin',locale:'fr',state:'COMPLETED',...options.user};
  return handler(c);
}
export const pgError=(code:string)=>Object.assign(new Error('synthetic database failure'),{code});
