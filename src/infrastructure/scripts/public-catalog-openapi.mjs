// Explicit contract of the PUBLIC WEBSITE catalogue (src/application/public-website/catalog-service.ts).
export function documentPublicCatalog(paths) {
 const string = {type:'string'};
 const nullable = schema=>({...schema,type:[schema.type,'null']});
 const object = (properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
 const array = items=>({type:'array',items});
 const day = {type:['string','null'],format:'date'};
 const site = object({id:{...string,pattern:'^[a-z0-9]+(?:-[a-z0-9]+)*$'},kind:{type:'string',enum:['KONEKTAG','CUSTOMER']}});
 const price = object({priceList:string,currency:{...string,pattern:'^[A-Z]{3}$'},amount:{type:'number',exclusiveMinimum:0,description:'ERPNext Price List rate in the currency unit (taxes excluded from this projection; computed by ERPNext on the quotation).'},
  uom:nullable(string),validFrom:day,validUpto:day,current:{type:'boolean',description:'false for a rate that only starts after today.'}});
 const priceSummary = {oneOf:[object({status:{type:'string',const:'PRICED'},from:price}),object({status:{type:'string',const:'NOT_PRICED'},from:{type:'null'}})],
  description:'NOT_PRICED when no current public rate exists. A missing rate is never reported as 0: a rate <= 0 is treated as absent.'};
 const media = object({id:string,kind:{type:'string',enum:['IMAGE','VIDEO','VIRTUAL_TOUR']},source:{type:'string',enum:['FRAPPE_FILE','EXTERNAL_LINK']},
  url:{type:'string',format:'uri',description:'Public /files/ URL of the Frappe site or external https link. Private files are never returned.'},mimeType:nullable(string),provider:nullable(string),isCover:{type:'boolean'}});
 const summary = {id:{...string,description:'ERPNext item code'},slug:string,name:string,group:nullable(string),shortDescription:nullable(string),cover:{oneOf:[media,{type:'null'}]},price:priceSummary,
  mediaCount:object({images:{type:'integer',minimum:0},videos:{type:'integer',minimum:0},virtualTours:{type:'integer',minimum:0}})};
 const characteristic = object({key:string,label:nullable(string),value:{type:['string','number','boolean']}});
 const resource = object({id:string,name:string,type:{type:'string',enum:['SPACE','EQUIPMENT']},capacity:{type:['integer','null']}});
 const resources = object({status:{type:'string',enum:['AVAILABLE','NOT_CONFIGURED','NOT_INSTALLED','UNAVAILABLE'],description:'konektag-abm link state: NOT_INSTALLED when the app is absent from the site.'},resources:array(resource)});
 const listBody = object({site,priceLists:array(string),groups:array(object({name:string,count:{type:'integer',minimum:1}})),total:{type:'integer',minimum:0},items:array(object(summary)),nextCursor:nullable(string)});
 const detailBody = object({site,item:object({...summary,description:nullable(string),variantOf:nullable(string),characteristics:array(characteristic),prices:array(price),media:array(media),resources})});
 const error = codes=>({type:'object',required:['error'],additionalProperties:false,properties:{error:{type:'string',enum:codes}}});
 const response = (description,schema,headers={})=>({description,headers:{'Cache-Control':{schema:string},...headers},content:{'application/json':{schema}}});
 const retry = {'Retry-After':{schema:{type:'integer',const:30}}};
 const ok = (description,schema)=>({description,headers:{'Cache-Control':{schema:{type:'string',const:'public, max-age=60, stale-while-revalidate=120'}},ETag:{schema:string}},content:{'application/json':{schema}}});
 const siteParams = [
  {name:'site',in:'query',required:false,schema:{type:'string',pattern:'^[a-z0-9]+(?:-[a-z0-9]+)*$',maxLength:160},description:'Public site id (for example rocher-des-ages). Exclusive with country.'},
  {name:'country',in:'query',required:false,schema:{type:'string',pattern:'^[A-Za-z]{2}$'},description:'Residence country routed to its Konektag site (FR/CG/LB rules). Exclusive with site.'},
  {name:'currency',in:'query',required:false,schema:{type:'string',pattern:'^[A-Z]{3}$'},description:'Only prices in this currency.'},
  {name:'If-None-Match',in:'header',required:false,schema:string},
 ];
 const failures = {
  '304':{description:'Not modified: the If-None-Match entity tag is current.',headers:{ETag:{schema:string}}},
  '400':response('site and country are both missing, both present, or site is malformed.',error(['SITE_REQUIRED','SITE_AND_COUNTRY_EXCLUSIVE','SITE_INVALID'])),
  '503':response('Site routing, configuration or Frappe unavailable. Frappe messages are never forwarded.',error(['CATALOG_UNAVAILABLE','SITE_ROUTING_UNAVAILABLE']),retry),
 };
 const common = {tags:['public'],security:[],'x-response-schema-scope':'Explicit public catalogue contract.'};
 paths['/api/public/catalog/items'].get = {...common,operationId:'listPublicCatalogItems',summary:'Public catalogue of a site',
  description:'Sellable, enabled, non-template ERPNext Items of the resolved site, restricted by its PUBLIC_CATALOG_SITES entry (Item Groups, publication field). Prices come from the configured public selling Price Lists, excluding customer and batch rates and expired periods. Internal reference Items and every non-allowlisted field (accounts, valuation, purchase, stock, owner) are never exposed. Sorted by group, name, code; cached 60 s server-side.',
  parameters:[...siteParams,
   {name:'group',in:'query',required:false,schema:{type:'string',maxLength:140},description:'Exact ERPNext Item Group.'},
   {name:'q',in:'query',required:false,schema:{type:'string',maxLength:100},description:'Case- and accent-insensitive search in name, code and description.'},
   {name:'priced',in:'query',required:false,schema:{type:'string',enum:['true','false']}},
   {name:'limit',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:50,default:24}},
   {name:'cursor',in:'query',required:false,schema:{type:'string',maxLength:200},description:'Opaque nextCursor of the previous page.'}],
  responses:{'200':ok('One page of the public catalogue; groups and total describe the filtered catalogue.',listBody),...failures,
   '404':response('Unknown site, or a site that does not publish its catalogue (indistinguishable).',error(['SITE_NOT_FOUND'])),
   '422':response('Invalid filter, limit, cursor or country.',error(['INVALID_PARAMETERS','RESIDENCE_COUNTRY_INVALID','COUNTRY_RULE_NOT_FOUND']))},
  'x-source':'src/api/routes/public/catalog/items/index.ts','x-error-codes':['SITE_REQUIRED','SITE_AND_COUNTRY_EXCLUSIVE','SITE_INVALID','SITE_NOT_FOUND','INVALID_PARAMETERS','RESIDENCE_COUNTRY_INVALID','COUNTRY_RULE_NOT_FOUND','CATALOG_UNAVAILABLE','SITE_ROUTING_UNAVAILABLE']};
 paths['/api/public/catalog/items/{ref}'].get = {...common,operationId:'getPublicCatalogItem',summary:'Public sheet of a catalogue entry',
  description:'Marketing sheet of one public Item: plain-text description, allowlisted characteristics and variant attributes, every public price (current and upcoming), gallery of public photos, videos and virtual tours (Frappe public files or external links attached to the Item), and konektag-abm resources selling it.',
  parameters:[{name:'ref',in:'path',required:true,schema:{type:'string',maxLength:140},description:'ERPNext item code or public slug.'},...siteParams],
  responses:{'200':ok('Public sheet.',detailBody),...failures,
   '404':response('Unknown site or Item; unpublished, disabled and internal Items are indistinguishable from absent ones.',error(['SITE_NOT_FOUND','ITEM_NOT_FOUND'])),
   '422':response('Invalid reference, currency or country.',error(['INVALID_PARAMETERS','RESIDENCE_COUNTRY_INVALID','COUNTRY_RULE_NOT_FOUND']))},
  'x-source':'src/api/routes/public/catalog/items/[ref].ts','x-error-codes':['SITE_REQUIRED','SITE_AND_COUNTRY_EXCLUSIVE','SITE_INVALID','SITE_NOT_FOUND','ITEM_NOT_FOUND','INVALID_PARAMETERS','RESIDENCE_COUNTRY_INVALID','COUNTRY_RULE_NOT_FOUND','CATALOG_UNAVAILABLE','SITE_ROUTING_UNAVAILABLE']};
 // Plain copies: shared objects would become YAML aliases and renumber every later one in docs/openapi.yaml.
 for (const path of ['/api/public/catalog/items','/api/public/catalog/items/{ref}']) paths[path].get = JSON.parse(JSON.stringify(paths[path].get));
}
