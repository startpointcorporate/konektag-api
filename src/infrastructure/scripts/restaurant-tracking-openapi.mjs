export function documentRestaurantTracking(paths) {
 const root='/api/public/marketplace/merchants/{slug}/restaurant';
 const str={type:'string'},num={type:'number'},date={type:'string',format:'date-time'};
 const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
 const response=(description,schema)=>({description,content:{'application/json':{schema}}});
 const error=description=>response(description,obj({error:str}));
 const trackingStatus={type:'string',enum:['Pending','Accepted','Preparing','Ready','Completed','Cancelled']};
 const summary=obj({reference:str,createdAt:date,orderMode:{type:'string',enum:['pickup','reservation']},currency:str,total:num,status:{type:'string',enum:['Open','Closed','Cancelled','Merged']},acceptanceStatus:{type:'string',enum:['Pending','Accepted','Rejected']},trackingStatus});
 for(const code of ['200','201']){
  const schema=paths[root+'/orders'].post.responses[code].content['application/json'].schema;
  schema.properties.trackingToken={type:'string',description:'Opaque encrypted tracking capability, issued immediately for explicit modes and exact replays. Valid24h, scope includes merchant/site/POS/order; never a reservation selection proof.'};
 }
 const lookup=paths[root+'/orders/lookup'].post;
 lookup.description='Find up to20 native Marketplace orders by exactly one reference, E.164 phone or optional customer email. Exact merchant/POS and nonempty K360 request key required; Pending, rejected and cancelled orders remain visible. Minimal summaries without contacts, customer names, notes or products. Rate limited; no ownership verification. Unknown/other establishment yields empty list.';
 lookup.requestBody={required:true,content:{'application/json':{schema:{oneOf:[obj({reference:{type:'string',minLength:1,maxLength:140}}),obj({phone:{type:'string',pattern:'^\\+[1-9]\\d{6,14}$'}}),obj({email:{type:'string',format:'email',maxLength:254}})]}}}};
 lookup.responses={'200':response('Newest orders first; opaque context-scoped tracking tokens expire24h after issue.',obj({orders:{type:'array',maxItems:20,items:obj({...summary.properties,token:str})}})),'400':error('INVALID_LOOKUP or INVALID_JSON.'),'404':error('CAPABILITY_NOT_AVAILABLE.'),'429':error('TOO_MANY_REQUESTS.'),'503':error('TRANSACTIONS_UNAVAILABLE.')};
 const client=paths[root+'/orders/{token}'].get;
 const shared=client.responses['200'].content['application/json'].schema;
 shared.properties.trackingStatus=trackingStatus;shared.properties.createdAt=date;shared.properties.orderMode=summary.properties.orderMode;
 const detail=obj({...summary.properties,lines:shared.properties.lines,merchantName:str,qrUrl:{anyOf:[{type:'string',format:'uri'},{type:'null'}]}});
 client.description+=' Also accepts AES-GCM tracking tokens purpose marketplace-order-tracking-v1, bound to exact slug/site/POS/order and24h expiry. Tracking tokens show Pending and cancelled orders; native43-character share secrets remain Accepted-only. trackingStatus derives live kitchen ticket state; native Closed with active kitchen tickets is not prematurely Completed. qrUrl is null before acceptance or after cancellation. No polling implied.';
 client.parameters.find(p=>p.name==='token').schema={type:'string',pattern:'^[A-Za-z0-9_-]{43,2048}$'};
 client.responses['200']=response('Minimal accepted share view or current native tracking view, without personal customer data.',{anyOf:[shared,detail]});
 // Clone locally to avoid anchor renumbering across unrelated generated paths.
 for(const suffix of ['/orders/lookup','/orders/{token}'])paths[root+suffix]=JSON.parse(JSON.stringify(paths[root+suffix]));
}
