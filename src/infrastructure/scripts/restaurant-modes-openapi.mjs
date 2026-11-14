/** Explicit schemas for adapter-computed Marketplace restaurant responses. */
export function documentRestaurantModes(paths) {
 const root='/api/public/marketplace/merchants/{slug}/restaurant';
 const str={type:'string'},num={type:'number'},bool={type:'boolean'};
 const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
 const arr=items=>({type:'array',items});
 const nullable=schema=>({anyOf:[schema,{type:'null'}]});
 const summary=obj({reference:str,date:{type:'string',format:'date'},time:str,partySize:{type:'integer',minimum:1}});
 const line=obj({itemCode:str,itemName:str,quantity:num,unitPrice:num,amount:num});
 const order=obj({reference:str,status:str,currency:str,total:num,lines:arr(line),orderMode:{type:'string',enum:['pickup','reservation']},reservation:nullable(summary),replayed:bool},['reference','status','currency','total','lines','replayed']);
 const response=(description,schema)=>({description,content:{'application/json':{schema}}});
 const error=description=>response(description,obj({error:str}));
 const menu=paths[root+'/menu'].get;
 const previous=JSON.parse(JSON.stringify(menu.responses?.['200']?.content?.['application/json']?.schema ?? {type:'object',properties:{}}));
 previous.type='object';previous.properties??={};previous.properties.orderModes=obj({pickup:obj({enabled:bool,available:bool}),reservation:obj({enabled:bool})});
 menu.responses['200']=response('Live native menu and immediate order modes. Missing adapter disables explicit modes while retaining menu.',previous);
 const post=paths[root+'/orders'].post;
 post.description='Legacy request without orderMode preserves native configured order path. Explicit pickup/reservation uses atomic K360 checkout with a durable unique key and payload fingerprint. Reservation selection tokens expire for new writes after 15 minutes; exact durable replays remain possible after expiry and cache loss. No ownership verification is required by the accepted product decision.';
 post.responses['200']=response('Durable replay (or unchanged legacy response without association fields).',order);
 post.responses['201']=response('Recorded native order (legacy omits association fields).',order);
 post.responses['409']=error('PICKUP_UNAVAILABLE, RESERVATION_INELIGIBLE, RESERVATION_SELECTION_EXPIRED, PRICE_CHANGED, ITEM_UNAVAILABLE or REQUEST_IN_PROGRESS.');
 post['x-error-codes']=[...new Set([...(post['x-error-codes']??[]),'PICKUP_UNAVAILABLE','RESERVATION_INELIGIBLE','RESERVATION_SELECTION_EXPIRED','INVALID_RESERVATION_SELECTION'])];
 const lookup=paths[root+'/reservations/lookup'].post;
 lookup.description='Rate-limited reference OR E.164 phone lookup, scoped to exact establishment/POS. No ownership verification. Unknown, other establishment and ineligible references all yield an empty list. Max 20 eligible reservations. No customer name, phone, note or products returned.';
 lookup.requestBody={required:true,content:{'application/json':{schema:{oneOf:[obj({reference:{type:'string',minLength:1,maxLength:140}}),obj({phone:{type:'string',pattern:'^\\+[1-9]\\d{6,14}$'}})]}}}};
 lookup.responses={'200':response('Minimal eligible selections; tokens are opaque authenticated ciphertext, valid for new writes for 15 minutes.',obj({reservations:{...arr(obj({...summary.properties,token:str})),maxItems:20}})),'400':error('INVALID_LOOKUP or INVALID_JSON.'),'404':error('CAPABILITY_NOT_AVAILABLE.'),'429':error('TOO_MANY_REQUESTS.'),'503':error('TRANSACTIONS_UNAVAILABLE.')};
 const client=paths[root+'/orders/{token}'].get;
 client.description='Read-only accepted order via 256-bit opaque share token. Native merchant acceptance and 7-day token validity are checked by K360. qrUrl points to the native authenticated Frappe Desk order on the server-configured site. No personal customer data. Cache-Control no-store, Referrer-Policy no-referrer and X-Robots-Tag noindex,nofollow.';
 client.parameters=[{name:'slug',in:'path',required:true,schema:str},{name:'token',in:'path',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}];
 client.responses={'200':response('Accepted minimal order and native Desk QR URL.',obj({reference:str,status:str,acceptanceStatus:{type:'string',const:'Accepted'},currency:str,total:num,lines:arr(line),merchantName:str,qrUrl:{type:'string',format:'uri'}})),'404':error('ORDER_NOT_AVAILABLE, including invalid/expired/unaccepted/rejected/cancelled.'),'429':error('TOO_MANY_REQUESTS.'),'503':error('TRANSACTIONS_UNAVAILABLE.')};
 // New computed values must not introduce shared references into legacy paths.
 menu.responses['200']=JSON.parse(JSON.stringify(menu.responses['200']));
 for (const code of ['200','201','409']) post.responses[code]=JSON.parse(JSON.stringify(post.responses[code]));
 // Keep unrelated YAML anchors stable when inserting computed schemas.
 for (const suffix of ['/reservations/lookup','/orders/{token}']) paths[root+suffix]=JSON.parse(JSON.stringify(paths[root+suffix]));
}
