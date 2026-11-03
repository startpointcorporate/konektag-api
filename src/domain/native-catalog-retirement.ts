export const NATIVE_CATALOG_RETIRED='NATIVE_CATALOG_RETIRED';
export function nativeCatalogRetired(){return Response.json({error:NATIVE_CATALOG_RETIRED,message:'La gestion des produits et de leurs taxes se fait dans ERPNext avec l’offre Pro. Les données historiques sont conservées.'},{status:410,headers:{'Cache-Control':'no-store'}});}
