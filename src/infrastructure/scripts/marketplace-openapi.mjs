// Explicit schemas for computed projection responses; consumed by the repository generator.
export function documentMarketplace(paths) {
 const string = {type:'string'};
 const number = {type:'number'};
 const integer = {type:'integer',minimum:0};
 const object = (properties,required=Object.keys(properties))=>({type:'object',properties,required});
 const array = items=>({type:'array',items});
 const city = object({id:string,name:string},[]);
 const activity = object({code:string,name:string});
 const item = object({slug:string,name:string,seoDescription:string,city,countryCode:string,
  activities:array(activity),coordinates:object({lat:number,lng:number}),logo:object({url:{type:'string',format:'uri'}}),
  distanceKm:{type:['number','null'],description:'Only returned for sort=distance; null when coordinates are absent.'}},['slug','name','activities']);
 const page = object({items:array(item),total:integer,page:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:50},sort:{type:'string',enum:['name','distance']}});
 const facets = object({countries:array(object({code:string,count:integer,cities:array(object({id:string,name:string,count:integer}))})),
  activities:array(object({...activity.properties,count:integer}))});
 const response = (description,schema)=>({description,content:{'application/json':{schema}}});
 const error = code=>object({error:{type:'string',const:code}});
 const list=paths['/api/public/marketplace/merchants'].get;
 list.description='SELECT-only reader of marketplace_published_establishments, Published rows only. All filters combine with AND before pagination. Name uses case/accent-insensitive Unicode normalization, with slug as stable tie-breaker. Distance is Haversine (km), ascending, missing coordinates last ordered by name then slug. q searches name, descriptions, activities and products/services if exposed by the projection. No typo tolerance. Empty pages retain the filtered total. No bbox required; map uses the current page.';
 list.parameters=Object.entries({
  q:{type:'string',maxLength:120},country:{type:'string',pattern:'^[A-Z]{2}$',description:'Valid ISO 3166-1 alpha-2 country code.'},
  city:{type:'string',minLength:1,maxLength:120,description:'Opaque city id from facets; never a city name.'},activity:{type:'string',minLength:1,maxLength:80},
  sort:{type:'string',enum:['name','distance'],default:'name'},lat:{type:'number',minimum:-90,maximum:90,description:'Required with lng when sort=distance.'},
  lng:{type:'number',minimum:-180,maximum:180,description:'Required with lat when sort=distance.'},
  page:{type:'integer',minimum:1,maximum:1000000,default:1},limit:{type:'integer',minimum:1,maximum:50,default:24},
 }).map(([name,schema])=>({name,in:'query',required:false,schema}));
 list.responses={'200':response('Globally filtered and sorted published establishments; sort echoed.',page),'422':response('Invalid query parameters.',error('INVALID_PARAMETERS')),'503':response('Projection unavailable.',error('PROJECTION_UNAVAILABLE'))};
 list['x-error-codes']=['INVALID_PARAMETERS','PROJECTION_UNAVAILABLE'];
 list['x-response-schema-scope']='Explicit public projection contract.';
 const facet=paths['/api/public/marketplace/facets'].get;
 facet.description='Global facets from Published projection rows only (independent of list filters). Country and city counts are establishment counts; activity counts count each establishment once per activity. Homonymous cities retain distinct ids. Entries with missing country/city/activity identifiers are omitted from the respective facet.';
 facet.responses={'200':response('Available published countries, cities and activities with counts.',facets),'503':response('Projection unavailable.',error('PROJECTION_UNAVAILABLE'))};
 facet['x-error-codes']=['PROJECTION_UNAVAILABLE'];
 facet['x-response-schema-scope']='Explicit public projection contract.';
 // Avoid shared schema references renumbering YAML anchors in unrelated operations.
 for (const path of ['/api/public/marketplace/merchants','/api/public/marketplace/facets']) paths[path].get=JSON.parse(JSON.stringify(paths[path].get));
}
