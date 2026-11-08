import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

const migrationPath='src/lib/infrastructure/database/migrations/229_tenant_members.sql';

describe('tenant member publication migration',()=>{
 it('rejects nullable envelope fields instead of letting SQL NULL bypass validation',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  for(const guard of ['p_operation IS NULL','p_publication_version IS NULL','p_team_member_id IS NULL','p_tenant_id IS NULL','p_source_site IS NULL','p_source_company IS NULL','p_public_slug IS NULL','p_event_key IS NULL']) expect(sql).toContain(guard);
  expect(sql).toContain('p_schema_version IS DISTINCT FROM 1');
  expect(sql).toContain("jsonb_typeof(p_snapshot)<>'object'");
 });
 it('serializes the first publication before locking or inserting the member row',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  const advisory=sql.indexOf('pg_advisory_xact_lock');
  const rowLock=sql.indexOf('FOR UPDATE',advisory);
  const insert=sql.indexOf('INSERT INTO konektag.tenant_members',advisory);
  expect(advisory).toBeGreaterThan(0);
  expect(rowLock).toBeGreaterThan(advisory);
  expect(insert).toBeGreaterThan(rowLock);
 });
 it('keeps source authorization, ownership, replay and unpublish controls in the real migration',async()=>{
  const sql=await readFile(migrationPath,'utf8');
  expect(sql).toContain("status='Active' AND db_role=session_user");
  expect(sql).toContain("RAISE EXCEPTION 'SOURCE_NOT_AUTHORIZED'");
  expect(sql).toContain("RAISE EXCEPTION 'OWNER_CONFLICT'");
  expect(sql).toContain("RETURN 'stale'");
  expect(sql).toContain("RETURN 'duplicate'");
  expect(sql).toContain("p_operation='Publish')<>(p_snapshot IS NOT NULL");
  expect(sql).toContain('REVOKE ALL ON FUNCTION');
 });
});
