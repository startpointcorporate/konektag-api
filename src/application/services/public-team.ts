import { createHash } from 'node:crypto';
import { z } from 'zod';

export const tenantIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const memberSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160);
export const teamListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: z.string().min(1).max(2048).optional(),
});
export type TeamListQuery = z.infer<typeof teamListQuery>;
export type Query = (sql: string, params: unknown[]) => Promise<{rows:any[]}>;

export class TeamNotFound extends Error {}
export class MemberNotFound extends Error {}
export class InvalidCursor extends Error {}
export class TeamProjectionUnavailable extends Error {}

type Cursor = {order:number; name:string; id:string};
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeCursor = (value?: string): Cursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Number.isInteger(parsed.order) || typeof parsed.name !== 'string' || !z.string().uuid().safeParse(parsed.id).success) throw new Error();
    return parsed;
  } catch { throw new InvalidCursor(); }
};
const text = (snapshot:any, key:string) => typeof snapshot?.[key] === 'string' ? snapshot[key] : null;
const photo = (snapshot:any) => snapshot?.photo && typeof snapshot.photo === 'object'
  ? {url:text(snapshot.photo,'url'), altText:text(snapshot.photo,'alt_text')} : null;
const summary = (row:any) => ({
  id:row.team_member_id, slug:row.public_slug, firstName:text(row.snapshot,'first_name'), lastName:text(row.snapshot,'last_name'),
  displayName:text(row.snapshot,'display_name'), jobTitle:text(row.snapshot,'job_title'), teamLabel:text(row.snapshot,'team_label'),
  countryCode:text(row.snapshot,'country_code'), cityName:text(row.snapshot,'city_name'), shortDescription:text(row.snapshot,'short_description'),
  photo:photo(row.snapshot), displayOrder:Number(row.snapshot?.display_order ?? 0), version:Number(row.publication_version),
});

export function publicTeam(query: Query) {
  const activeTenant = async (tenantId:string) => {
    const result = await query(`SELECT EXISTS (SELECT 1 FROM konektag.tenant_members_sites WHERE tenant_id=$1 AND status='Active') AS active`,[tenantId]);
    return Boolean(result.rows[0]?.active);
  };
  return {
    async list(tenantId:string, input:TeamListQuery) {
      try {
        if (!await activeTenant(tenantId)) throw new TeamNotFound();
        const cursor=decodeCursor(input.cursor);
        const {rows}=await query(`SELECT m.team_member_id,m.public_slug,m.publication_version,m.snapshot,m.delivered_at,
          COALESCE((m.snapshot->>'display_order')::integer,0) AS display_order,
          COALESCE(m.snapshot->>'display_name','') AS display_name
          FROM konektag.tenant_members m JOIN konektag.tenant_members_sites s ON s.id=m.tenant_members_site_id AND s.tenant_id=m.tenant_id
          WHERE m.tenant_id=$1 AND m.status='Published' AND s.status='Active'
          AND ($2::integer IS NULL OR (COALESCE((m.snapshot->>'display_order')::integer,0),COALESCE(m.snapshot->>'display_name','') COLLATE "C",m.team_member_id) > ($2,$3 COLLATE "C",$4::uuid))
          ORDER BY display_order,display_name COLLATE "C",team_member_id LIMIT $5`,[tenantId,cursor?.order??null,cursor?.name??null,cursor?.id??null,input.limit+1]);
        const page=rows.slice(0,input.limit);
        const last=page.at(-1);
        return {tenantId,items:page.map(summary),nextCursor:rows.length>input.limit&&last?encodeCursor({order:Number(last.display_order),name:last.display_name,id:last.team_member_id}):null};
      } catch (error) { if (error instanceof TeamNotFound || error instanceof InvalidCursor) throw error; throw new TeamProjectionUnavailable(); }
    },
    async detail(tenantId:string, slug:string) {
      try {
        if (!await activeTenant(tenantId)) throw new TeamNotFound();
        const {rows}=await query(`SELECT m.* FROM konektag.tenant_members m JOIN konektag.tenant_members_sites s ON s.id=m.tenant_members_site_id AND s.tenant_id=m.tenant_id
          WHERE m.tenant_id=$1 AND m.public_slug=$2 AND m.status='Published' AND s.status='Active'`,[tenantId,slug]);
        const row=rows[0]; if (!row) throw new MemberNotFound();
        const member=summary(row); const snapshot=row.snapshot;
        return {tenantId,member:{...member,longDescription:text(snapshot,'long_description'),contacts:{email:text(snapshot,'public_email'),phone:text(snapshot,'public_phone'),whatsapp:text(snapshot,'public_whatsapp')},links:Array.isArray(snapshot?.links)?snapshot.links:[],updatedAt:new Date(row.delivered_at).toISOString()}};
      } catch (error) { if (error instanceof TeamNotFound || error instanceof MemberNotFound) throw error; throw new TeamProjectionUnavailable(); }
    }
  };
}

export const etag = (value:unknown) => `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}"`;
export async function defaultPublicTeam() { const {query}=await import('../../infrastructure/database/pool.ts'); return publicTeam(query); }
