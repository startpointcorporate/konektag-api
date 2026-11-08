import type {RequestContext} from '../../../../../http.ts';
import {defaultPublicTeam,etag,InvalidCursor,publicTeam,TeamNotFound,teamListQuery,TeamProjectionUnavailable,tenantIdSchema} from '../../../../../../application/services/public-team.ts';
const response=(body:unknown,status:number,headers:Record<string,string>={})=>Response.json(body,{status,headers});
export const GET=async(ctx:RequestContext,reader?:ReturnType<typeof publicTeam>):Promise<Response>=>{
 const tenantId=ctx.params.tenantId ?? ''; const parsedTenant=tenantIdSchema.safeParse(tenantId); const parsed=teamListQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
 if(!parsedTenant.success||!parsed.success)return response({error:'INVALID_PARAMETERS'},422,{'Cache-Control':'no-store'});
 try { reader??=await defaultPublicTeam(); const body=await reader.list(tenantId,parsed.data); return response(body,200,{'Cache-Control':'public, max-age=0, must-revalidate',ETag:etag(body)}); }
 catch(error){if(error instanceof InvalidCursor)return response({error:'INVALID_PARAMETERS'},422,{'Cache-Control':'no-store'});if(error instanceof TeamNotFound)return response({error:'TEAM_NOT_FOUND'},404,{'Cache-Control':'no-store'});if(error instanceof TeamProjectionUnavailable)return response({error:'PROJECTION_UNAVAILABLE'},503,{'Cache-Control':'no-store','Retry-After':'30'});throw error;}
};
