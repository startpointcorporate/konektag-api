import type {RouteHandler} from '../../http';
export const POST:RouteHandler=async()=>Response.json({error:'CONTENT_LINK_RETIRED',message:'Utilisez les Reels et le partage natif de leur contenu.'},{status:410});
