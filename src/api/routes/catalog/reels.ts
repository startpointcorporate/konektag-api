import type {RouteHandler} from '../../http';
import {listReels} from '../../../application/public-catalog-service.ts';
export const GET:RouteHandler=async({url})=>{
 const city=url.searchParams.get('city'),category=url.searchParams.get('category')||undefined;
 if(!city||city.length>200||(category?.length||0)>200)return Response.json([]);
 return Response.json(await listReels({city,category,locale:url.searchParams.get('locale')||undefined}),{headers:{'Cache-Control':'no-store'}});
};
