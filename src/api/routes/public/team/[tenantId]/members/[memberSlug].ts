import type {RequestContext} from '../../../../../http.ts';
import {defaultPublicTeam,etag,MemberNotFound,memberSlugSchema,publicTeam,TeamNotFound,TeamProjectionUnavailable,tenantIdSchema} from '../../../../../../application/services/public-team.ts';
const response=(body:unknown,status:number,headers:Record<string,string>={})=>Response.json(body,{status,headers});
export const GET=async(ctx:RequestContext,reader?:ReturnType<typeof publicTeam>):Promise<Response>=>{
 const tenantId=ctx.params.tenantId ?? '',slug=ctx.params.memberSlug ?? '';
 if(!tenantIdSchema.safeParse(tenantId).success||!memberSlugSchema.safeParse(slug).success)return response({error:'INVALID_PARAMETERS'},422,{'Cache-Control':'no-store'});
 try {reader??=await defaultPublicTeam();const body=await reader.detail(tenantId,slug);return response(body,200,{'Cache-Control':'public, max-age=0, must-revalidate',ETag:etag(body)});}
 catch(error){if(error instanceof TeamNotFound)return response({error:'TEAM_NOT_FOUND'},404,{'Cache-Control':'no-store'});if(error instanceof MemberNotFound)return response({error:'MEMBER_NOT_FOUND'},404,{'Cache-Control':'no-store'});if(error instanceof TeamProjectionUnavailable)return response({error:'PROJECTION_UNAVAILABLE'},503,{'Cache-Control':'no-store','Retry-After':'30'});throw error;}
};
