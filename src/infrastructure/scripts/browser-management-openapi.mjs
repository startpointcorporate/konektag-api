export function documentBrowserManagement(paths) {
 const root='/api/public/marketplace/merchants/{slug}/restaurant';
 const clone=value=>JSON.parse(JSON.stringify(value));
 const str={type:'string'},bool={type:'boolean'},num={type:'number'};
 const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
 const arr=items=>({type:'array',items});
 const token={type:'string',minLength:44,maxLength:2048,description:'Opaque AES-GCM creator capability, distinct purpose from all lookup, selection and tracking proofs. Never put in a shared URL.'};
 const seed={type:'string',pattern:'^[A-Za-z0-9_-]{43}$',description:'Browser-generated256bit secret persisted before creating. Only its scoped hash reaches Frappe; never late-claim a previous unowned record.'};
 const kind={type:'string',enum:['order','reservation']};
 const customer=obj({name:{type:'string',maxLength:140},phone:{type:'string',maxLength:40},email:{type:'string',maxLength:254}},['name','phone']);
 const selected=obj({reference:str,date:{type:'string',format:'date'},time:str,partySize:{type:'integer',minimum:1}});
 const booking=obj({...selected.properties,status:str,canCancel:bool,canAssociate:bool,customer,note:str},['reference','date','time','partySize','status','canCancel','canAssociate']);
 const line=obj({itemCode:str,itemName:str,quantity:num,unitPrice:num,amount:num});
 const order=obj({reference:str,status:{type:'string',enum:['Open','Closed','Cancelled','Merged']},acceptanceStatus:{type:'string',enum:['Pending','Accepted','Rejected']},trackingStatus:{type:'string',enum:['Pending','Accepted','Preparing','Ready','Completed','Cancelled']},createdAt:{type:'string',format:'date-time'},orderMode:{type:'string',enum:['pickup','reservation']},currency:str,total:num,lines:arr(line),canEdit:bool,customer,note:str,reservation:{anyOf:[selected,{type:'null'}]},merchantName:str},['reference','status','acceptanceStatus','trackingStatus','orderMode','currency','total','lines','canEdit']);
 const activity=obj({index:{type:'integer',minimum:0,maximum:19},state:{type:'string',enum:['active','terminal','not_found','pending']},type:kind,reference:str,createdAt:{type:'string',format:'date-time'},version:{type:'string',minLength:1,maxLength:128,description:'Exact native revision, preserving all six microseconds. Never round-trip through JavaScript Date.'},snapshot:{anyOf:[booking,order],description:'Private creator-authorized state only; contacts are never added to public lookup/tracking DTOs or persistent browser collections.'},managementToken:token,trackingToken:str,reservationToken:str},['index','state','type']);
 const response=(description,schema)=>({description,content:{'application/json':{schema}}});
 const error=description=>response(description,obj({error:str}));
 for(const suffix of ['/orders','/reservation-requests']){
  const post=paths[root+suffix].post;
  post.requestBody??={required:true,content:{'application/json':{schema:obj({},[])}}};
  const schema=post.requestBody.content['application/json'].schema;
  schema.type='object';schema.properties??={};schema.properties.managementKey=clone(seed);
  post.description+=' Optional creator managementKey is stored as a native owner hash atomically on first creation, never on a late claim. Native ownership must be explicitly verified before a management token is issued. An order managementKey requires an explicit orderMode; legacy bodies without it are preserved.';
  for(const code of ['200','201']){
   if(suffix==='/orders'){
    const result=post.responses[code].content['application/json'].schema;
    result.properties.managementToken=clone(token);result.properties.activity=clone(activity);
   }else post.responses[code]=response('Current native booking status and optional verified creator activity.',clone(obj({reference:str,status:str,replayed:bool,managementToken:token,activity},['reference','status','replayed'])));
  }
  post.responses['409']??=error('MANAGEMENT_NOT_AVAILABLE or native business conflict.');
 }
 const batch=paths[root+'/browser-activities'].post;
 batch.description='Restore up to20 browser-owned active records, max10reservations and10orders, in one native RPC. Accept a management proof or a pending creation key/secret after response loss. Expired genuine management proofs may be reconciled against the immutable native owner hash; renew90days only if active and expired/within7days. Otherwise return the SAME management token to avoid cross-tab storage loops. Terminal records return a summary without renewed management rights. Lookup/selection/tracking/share tokens never grant management. No contact payload is persisted by the browser.';
 const pending=obj({type:kind,idempotencyKey:{type:'string',pattern:'^[A-Za-z0-9_-]{16,100}$'},managementKey:seed});
 batch.requestBody={required:true,content:{'application/json':{schema:obj({activities:{type:'array',maxItems:20,items:{oneOf:[obj({type:kind,managementToken:token}),pending]},allOf:['order','reservation'].map(type=>({contains:{type:'object',properties:{type:{const:type}},required:['type']},minContains:0,maxContains:10}))}})}}};
 batch.responses={'200':response('Original input indices preserved. Active creator states, terminal summaries, not_found proofs or unresolved pending attempts.',obj({activities:{...arr(activity),maxItems:20}})),'400':error('INVALID_REQUEST or INVALID_JSON.'),'404':error('CAPABILITY_NOT_AVAILABLE.'),'429':error('TOO_MANY_REQUESTS; retain browser proof.'),'503':error('TRANSACTIONS_UNAVAILABLE; retain browser proof.')};
 const common={managementToken:token,expectedVersion:activity.properties.version};
 const inputCustomer=obj({name:{type:'string',minLength:2,maxLength:120},phone:{type:'string',pattern:'^\\+[1-9]\\d{6,14}$'},email:{type:'string',format:'email',maxLength:254}},['name','phone']);
 const cartLine=obj({itemCode:{type:'string',minLength:1,maxLength:140},quantity:{type:'integer',minimum:1,maximum:50},unitPrice:{type:'number',minimum:0,maximum:100000000}});
 for(const [suffix,body,description] of [
  ['/orders',obj({...common,currency:{type:'string',pattern:'^[A-Z]{3}$'},lines:{type:'array',minItems:1,maxItems:40,items:cartLine},customer:inputCustomer,note:{type:'string',maxLength:500}},['managementToken','expectedVersion','currency','lines']),'Creator edit only native Open/Pending with no ticket (evenNew/Cancelled), invoice, bill or processing marker. Mode/reservation link are immutable. Current native locks and exact expectedVersion coordinate with merchant acceptance/kitchen/payment. Fresh quote follows atomic price/item refusal.'],
  ['/reservation-requests',obj({...common,action:{type:'string',const:'cancel'}}),'Creator cancellation only native Requested, including past-time Requested. Confirmation or state/version races are refused. Never delete a reservation or implicitly cancel its orders.'],
 ]){
  const patch=paths[root+suffix].patch;
  patch.description=description+' Requires fresh creator capability and idempotency key. Exact last mutation replays without reapplying; changed payload under same key refuses422, older revision refuses409. Expired creator proof may be reconciled first, never used directly to mutate.';
  patch.requestBody={required:true,content:{'application/json':{schema:body}}};
  patch.parameters=[{name:'slug',in:'path',required:true,schema:str},{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9_-]{16,100}$'}}];
  patch.responses={'200':response('Current creator activity and whether this exact mutation was replayed.',obj({activity,replayed:bool})),'400':error('INVALID_REQUEST.'),'404':error('ACTIVITY_NOT_FOUND or CAPABILITY_NOT_AVAILABLE.'),'409':error('VERSION_CONFLICT, RESERVATION_NOT_CANCELLABLE, ORDER_NOT_EDITABLE or price/item refusal with optional fresh quote.'),'410':error('MANAGEMENT_TOKEN_EXPIRED; reconcile before a new mutation.'),'422':error('IDEMPOTENCY_KEY_REUSED or CURRENCY_MISMATCH.'),'429':error('TOO_MANY_REQUESTS.'),'503':error('TRANSACTIONS_UNAVAILABLE.')};
  paths[root+suffix].patch=clone(patch);
 }
 paths[root+'/browser-activities'].post=clone(batch);
}
