import json,pathlib,hashlib,re,collections
ROOT=pathlib.Path('.')
BASE=json.load(open('docs/rest-test-coverage.json'))
OPS={o['operation']:o for o in BASE['operations']}
SPECS={}; GUARDS={}; SNAP={}
def q(sql,params=[]):return dict(sql=sql,params=params)
def eq(path,value):return dict(path=path,equals=value)
def typ(path,value):return dict(path=path,type=value)
def sub(path,value):return dict(path=path,subset=value)
def add(op,rule,scenarios,unexercised=[]):
 assert op in OPS,op
 assert op not in SPECS,op
 o=OPS[op];s=pathlib.Path(o['source']).read_text()
 SPECS[op]=dict(operation=op,domain=o['domain'],source=o['source'],sourceSha256=hashlib.sha256(s.encode()).hexdigest(),rule=rule,scenarios=scenarios,unexercised=unexercised)
def step(op,body=None,actor=None,status=200,checks=[],path=None,**kw):
 method,route=op.split(' ',1);v=dict(method=method,path=path or route,status=status,assertions=checks)
 if body is not None:v['body']=body
 if actor:v['actor']=actor
 return dict(v,**kw)
def case(name,steps,actors=[],resources=[],deps=['PostgreSQL'],unchanged=[],mode='read',**kw):
 return dict(name=name,actors=actors,resources=resources,dependencies=deps,unchanged=unchanged,mode=mode,steps=steps,**kw)
def bad(op,name,body,status,error,actor='owner',field='error',path=None,unchanged=['owner'],**kw):
 checks=[eq('/'+field,error)] if error is not None else [typ('/errors','object')]
 return case(name,[step(op,body,actor,status,checks,path,**kw)],actors=[actor] if actor else [],unchanged=unchanged,mode='validation')
def read(op,name,sql,params,field='',actor='owner',resources=[],mode='subset',single=True,path=None,checks=[],minrows=1,deps=['PostgreSQL']):
 query=q(sql,params)
 return case(name,[step(op,actor=actor,path=path,checks=checks,oracles=[dict(query,responsePath=field,mode=mode,single=single)])],actors=[actor] if actor else [],resources=resources,deps=deps,read=[dict(query,name='witness',minRows=minrows)])
def blocked(name,reason):return case(name,[],deps=[],blocked=reason)
def write(op,name,body,checks,sql,params,expected,actor='owner',resources=[],path=None,status=200,cleanup=[],preconditions=[]):
 return case(name,[step(op,body,actor,status,checks,path,oracles=[dict(q(sql,params),equals=expected)])],actors=[actor],resources=resources,mode='fixture-write',cleanup=cleanup,preconditions=preconditions)
OWNER='${owner.userId}';KC='${owner.keycloakId}';CUSTOMER='${customer.userId}';OTHER='${stranger.userId}';MERCHANT='${merchant.id}'
SNAP['owner']=q('SELECT id,encrypted_data,country,country_confirmed_at,state,role,version,banned_at,access_status,email_verified,email_verification_token FROM konektag.users WHERE id=$1',[OWNER])
SNAP['merchant']=q('SELECT * FROM konektag.merchant_profiles WHERE id=$1',[MERCHANT])
SNAP['keys']=q('SELECT * FROM konektag.user_api_keys WHERE user_id=$1 ORDER BY id',[OWNER])
SNAP['claims']=q('SELECT * FROM konektag.payment_claims WHERE user_id=$1 ORDER BY id',[OWNER])
SNAP['orders']=q('SELECT * FROM konektag.api_payment_orders WHERE target_user_id=$1 ORDER BY id',[OWNER])
SNAP['consents']=q('SELECT * FROM konektag.communication_consents WHERE user_id=$1 ORDER BY channel',[OWNER])
SNAP['send']=q('SELECT * FROM konektag.k_send_intents WHERE sender_user_id=$1 ORDER BY id',[OWNER])
SNAP['recipients']=q('SELECT * FROM konektag.k_send_beneficiaries WHERE owner_keycloak_id=$1 ORDER BY id',[KC])
SNAP['public-profile']=q('SELECT * FROM konektag.user_public_profiles WHERE user_id=$1',[OWNER])
SNAP['core']=q('SELECT * FROM konektag.core_transactions WHERE customer_user_id=$1 ORDER BY id',[OWNER])
SNAP['kyc']=q('SELECT * FROM konektag.kyc_orders WHERE user_id=$1 ORDER BY id',[OWNER])
SNAP['loyalty']=q('SELECT * FROM konektag.loyalty_transactions WHERE user_id=$1 ORDER BY id',[OWNER])
GUARDS['merchant']=q('SELECT id FROM konektag.merchant_profiles WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',[MERCHANT,OWNER])
for name,table,ownercol in [('claim','payment_claims','user_id'),('order','api_payment_orders','target_user_id'),('send','k_send_intents','sender_user_id'),('kyc','kyc_orders','user_id')]:
 GUARDS[name]=q(f'SELECT id FROM konektag.{table} WHERE id=$1 AND {ownercol}=$2',['${'+name+'.id}',OWNER])
GUARDS['recipient']=q('SELECT id FROM konektag.k_send_beneficiaries WHERE id=$1 AND owner_keycloak_id=$2',['${recipient.id}',KC])
GUARDS['foreignSend']=q('SELECT id FROM konektag.k_send_intents WHERE id=$1 AND sender_user_id=$2',['${foreignSend.id}',OTHER])
GUARDS['foreignMerchant']=q('SELECT id FROM konektag.merchant_profiles WHERE id=$1 AND user_id=$2',['${foreignMerchant.id}',OTHER])
# API keys: genuine creation and revocation use a fresh run label, secret never persisted to the report.
op='GET /api/account/api-keys'
add(op,'Only dashboard-session owner metadata is listed; credentials must not leak.',[read(op,'Owner metadata equals PostgreSQL, secret/hash excluded','SELECT id,label,api_key,created_at,expires_at,revoked_at,last_used_at FROM konektag.user_api_keys WHERE user_id=$1 ORDER BY created_at DESC',[OWNER],'/keys',mode='equal',single=False,minrows=0),bad(op,'API credentials cannot manage credentials',None,403,'DASHBOARD_SESSION_REQUIRED',headers={'Authorization':'token ${apiKey.key}:${apiKey.secret}'})],['The API-key management refusal needs an existing dedicated test API credential.'])
op='POST /api/account/api-keys'
create=step(op,{'label':'${run.id}'},'owner',201,[dict(path='/api_key',matches='^ktg_[a-f0-9]{32}$'),dict(path='/api_secret',matches='^[a-f0-9]{64}$')],capture={'keyId':'/id'},responseHeaders={'cache-control':'no-store'},oracles=[dict(q('SELECT label,revoked_at FROM konektag.user_api_keys WHERE id=$1 AND user_id=$2',['${captured.keyId}',OWNER]),equals=[{'label':'${run.id}','revoked_at':None}])])
revoke=step('DELETE /api/account/api-keys/{id}',actor='owner',path='/api/account/api-keys/${captured.keyId}',checks=[eq('/revoked',True)])
add(op,'Create once, store a hash, list without the secret; reject origin and expired timestamps.',[case('Create and automatically revoke a run-owned key',[create],actors=['owner'],mode='fixture-write',cleanup=[revoke]),bad(op,'Expired credentials are rejected',{'label':'${run.id}','expires_at':'2000-01-01T00:00:00Z'},400,'EXPIRY_MUST_BE_FUTURE',unchanged=['keys']),bad(op,'Cross-origin management rejected before insert',{'label':'${run.id}'},403,'ORIGIN_DENIED',origin=False,unchanged=['keys'])])
op='DELETE /api/account/api-keys/{id}'
add(op,'Revocation is owner-bound and one-time; a second attempt returns NOT_FOUND.',[case('Revoke newly created credential, repeat returns NOT_FOUND',[create,revoke,step(op,actor='owner',path='/api/account/api-keys/${captured.keyId}',status=404,checks=[eq('/error','NOT_FOUND')],oracles=[dict(q('SELECT (revoked_at IS NOT NULL) AS revoked FROM konektag.user_api_keys WHERE id=$1 AND user_id=$2',['${captured.keyId}',OWNER]),equals=[{'revoked':True}])])],actors=['owner'],mode='fixture-write'),bad(op,'Invalid identifier does not revoke keys',None,400,'INVALID_ID',path='/api/account/api-keys/not-a-uuid',unchanged=['keys'])])
op='POST /api/account/update-profile'
add(op,'Profile fields are whitelisted; rejected updates leave the encrypted profile intact.',[bad(op,'Reject privilege injection',{'role':'admin'},400,'Champ non autorisé: role'),bad(op,'Reject empty patch',{},400,'Aucun champ à mettre à jour')],['Positive encrypted-profile update not exercised: needs reversible encrypted test profile and outbox compensation.'])
op='GET /api/account/payment-claims'
add(op,'Claims are scoped to signed-in user, newest first, maximum 50.',[read(op,'Owner claim visibility equals persisted business identifiers','SELECT id,payment_order_id AS "paymentOrderId",status,reason FROM konektag.payment_claims WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[OWNER],'/claims',single=False,mode='subset')])
op='POST /api/account/payment-claims'
add(op,'Claim requires reason and order/reference; order ownership is checked transactionally.',[bad(op,'Malformed order UUID rejected',{'paymentOrderId':'wrong','reason':'test'},400,'INVALID_PAYMENT_ORDER',unchanged=['claims']),bad(op,'Reference and reason required',{},400,'INVALID_CLAIM',unchanged=['claims'])],['Provider recovery/credit path intentionally not invoked on live settlement data.'])
op='POST /api/account/transactions/{id}/retry'
add(op,'Only failed/expired/cancelled wallet recharges owned by the user can be retried.',[case('A paid test order cannot create another checkout',[step(op,actor='owner',path='/api/account/transactions/${order.id}/retry',status=409,checks=[eq('/error','TRANSACTION_NOT_RETRYABLE')])],actors=['owner'],resources=['order'],unchanged=['orders'],mode='validation',preconditions=[dict(q("SELECT state FROM konektag.api_payment_orders WHERE id=$1",['${order.id}']),equals=[{'state':'paid'}])])],['Successful retry creates a payable checkout; excluded until an expired test recharge is designated.'])
op='GET /api/account/pending-transactions'
add(op,'Expired abandoned checkouts disappear; provider-backed attempts stay pending and checkout hashes never leak.',[case('Pending reads remain scoped to a test account',[step(op,actor='owner',checks=[typ('/transactions','array')],oracles=[dict(q("SELECT id FROM konektag.api_payment_orders WHERE target_user_id=$1 AND state IN ('pending','processing','awaiting_mobile_money') ORDER BY created_at DESC LIMIT 20",[OWNER]),responsePath='/transactions',mode='contains')])],actors=['owner'],mode='fixture-write',preconditions=[dict(q("SELECT id FROM konektag.api_payment_orders WHERE target_user_id=$1 AND state='pending' AND created_at>now()-interval '10 minutes'",[OWNER]),minRows=1)])],['GET performs expiry UPDATE; never treat as read-only. Provider-attempt TTL boundaries require dedicated order fixtures.'])
op='GET /api/account/history'
add(op,'Wallet history signs debit quantities negative and credit quantities positive, using K as unit.',[read(op,'Persisted credit/debit quantities and history labels match',"SELECT CASE WHEN w.direction='credit' THEN w.quantity_k ELSE -w.quantity_k END::float8 AS amount,'K' AS symbol,'Complété' AS status FROM konektag.k_wallet_entries w JOIN konektag.parties p ON p.id=w.party_id WHERE p.keycloak_id=$1 ORDER BY w.created_at DESC LIMIT 50",[KC],single=False,mode='subset')])
op='GET /api/account/balance'
add(op,'Available points equal the persisted wallet accounting balance and reservations.',[read(op,'Live wallet credit minus debit is returned as points_balance',"SELECT COALESCE(SUM(CASE WHEN w.direction='credit' THEN w.quantity_k ELSE -w.quantity_k END),0)::float8 AS points_balance FROM konektag.k_wallet_entries w JOIN konektag.parties p ON p.id=w.party_id WHERE p.keycloak_id=$1",[KC],checks=[eq('/currency','EUR'),eq('/source','points')],path='/api/account/balance?currency=EUR')])
op='GET /api/account'
add(op,'Cashback history is scoped to the account, not another user ledger.',[read(op,'Cashback details contain only persisted cashback entries',"SELECT amount,created_at,document_ref FROM konektag.ledger_entries WHERE client_id=$1 AND document_type='Cashback' ORDER BY created_at DESC LIMIT 20",[OWNER],'/history',path='/api/account?section=cashback',single=False,mode='subset')],['Overview/balance/history section variants remain independent of the cashback scenario.'])
# K Send / beneficiaries: integer quantity, own sender and saved recipient scope.
op='POST /api/k/send/quote'
add(op,'A quote transfers no money and totalK equals integral quantityK.',[case('Quote 7 K has no fee and does not change an intent',[step(op,{'quantityK':7},checks=[eq('/quantityK',7),eq('/totalK',7),dict(path='/expiresAt',matches='^20')]),step(op,{'quantityK':0},status=400,checks=[eq('/error','INVALID_K_SEND_QUANTITY')]),step(op,{'quantityK':1.5},status=400,checks=[eq('/error','INVALID_K_SEND_QUANTITY')])],deps=[])])
op='GET /api/k/send'
add(op,'List is scoped to sender and supports status/pagination.',[read(op,'Sender intent and quantity match PostgreSQL','SELECT id,recipient_user_id AS "recipientUserId",quantity_k::float8 AS "quantityK",status FROM konektag.k_send_intents WHERE sender_keycloak_id=$1 ORDER BY created_at DESC LIMIT 20',[KC],'/data',single=False,mode='subset')])
op='GET /api/k/send/{id}'
add(op,'Only the sender can read an intent.',[read(op,'Own intent returns persisted quantity and destination','SELECT id,recipient_user_id AS "recipientUserId",quantity_k::float8 AS "quantityK",status FROM konektag.k_send_intents WHERE id=$1',['${send.id}'],resources=['send'],path='/api/k/send/${send.id}'),case('Another existing test user is refused',[step(op,actor='stranger',path='/api/k/send/${send.id}',status=403,checks=[eq('/error','Forbidden')])],actors=['owner','stranger'],resources=['send'],unchanged=['send'])])
for method in ['POST','DELETE']:
 op=f'{method} /api/k/send/{{id}}'
 add(op,'Foreign sender cannot request OTP, fund or cancel an intent.',[case('Foreign intent remains unchanged after ownership rejection',[step(op,{},'stranger',403,[eq('/error','Forbidden')],'/api/k/send/${send.id}')],actors=['owner','stranger'],resources=['send'],mode='validation',unchanged=['send'])],['Successful funding/cancellation not run on shared financial data; a disposable intent and real OTP/ledger audit are required.'])
op='POST /api/k/send'
add(op,'Only positive whole K quantities are accepted; recipient and available balance are checked before creation.',[bad(op,'Fractional K is refused',{'recipientUserId':CUSTOMER,'quantityK':0.5},400,'K_SEND_INVALID_REQUEST',unchanged=['send']),bad(op,'Negative K is refused',{'recipientUserId':CUSTOMER,'quantityK':-1},400,'K_SEND_INVALID_REQUEST',unchanged=['send'])],['Successful K-send intent creation requires positive disposable test wallet balance.'])
op='GET /api/k/send/balance'
# Reservations use k_points_reservations; availability is verified by the account balance cross-check below.
add(op,'Sendable K must agree with the same real wallet balance exposed by account API.',[case('Sendable balance and account availability are equal',[step('GET /api/account/balance',actor='owner',checks=[eq('/source','points')],capture={'available':'/points_available'}),step(op,actor='owner',checks=[eq('/availableK','${captured.available}')])],actors=['owner'])])
op='GET /api/k/send/recipient'
add(op,'Beneficiary list contains only active, nondeleted records of current Keycloak owner.',[read(op,'Exact saved-beneficiary list excludes inactive and other owners','SELECT id,owner_keycloak_id,recipient_user_id,full_name,is_active,version FROM konektag.k_send_beneficiaries WHERE owner_keycloak_id=$1 AND deleted_at IS NULL AND is_active=true ORDER BY updated_at DESC LIMIT 50',[KC],single=False,mode='equal')])
op='GET /api/k/send/recipient/{id}/qr'
add(op,'Recipient QR is generated only from a saved owned beneficiary.',[read(op,'QR payload identifies the exact saved recipient',"SELECT 'k_send_recipient' AS type,id,recipient_user_id AS \"recipientUserId\" FROM konektag.k_send_beneficiaries WHERE id=$1 AND owner_keycloak_id=$2 AND is_active AND deleted_at IS NULL",['${recipient.id}',KC],path='/api/k/send/recipient/${recipient.id}/qr',resources=['recipient'])])
op='POST /api/k/send/recipient'
add(op,'Recipient identity and display name are both required.',[bad(op,'Incomplete beneficiary does not persist',{'recipientUserId':CUSTOMER},400,'K_SEND_RECIPIENT_INVALID',unchanged=['recipients'])],['Positive beneficiary upsert needs an explicit test-only recipient pair; existing aliases must be preserved.'])
for method in ['PUT','DELETE']:
 op=f'{method} /api/k/send/recipient'
 add(op,'A recipient identifier is mandatory before mutation.',[bad(op,'Missing recipient id leaves saved beneficiaries unchanged',{} if method=='PUT' else None,400,'K_SEND_RECIPIENT_ID_REQUIRED',unchanged=['recipients'])],['Positive update/delete limited to disposable saved beneficiary fixtures.'])
# Country confirmation / password policy.
op='GET /api/auth/country-confirmation'
add(op,'Country confirmation is due after one year or when missing; identity comes from Keycloak.',[read(op,'Country and due status agree with persisted confirmation age',"SELECT country, country_confirmed_at AS \"countryConfirmedAt\",(country_confirmed_at IS NULL OR country_confirmed_at < now()-interval '365 days') AS due FROM konektag.users WHERE id=$1",[OWNER])])
op='POST /api/auth/country-confirmation'
add(op,'Country must be ISO alpha2 and supported by an approved entity.',[bad(op,'Country with invalid length rejected',{'country':'FRA'},400,'INVALID_COUNTRY')],['Positive country change changes regulatory context; only a dedicated test user should be used.'])
op='POST /api/auth/change-password'
add(op,'Password requires the current secret and at least eight characters before Keycloak mutation.',[bad(op,'Weak password never reaches resetPassword',{'currentPassword':'unused-before-validation','newPassword':'short'},400,'Le nouveau mot de passe doit contenir au moins 8 caractères.',field='message'),bad(op,'Both passwords are required',{},400,'Current password and new password are required.',field='message')],['No successful password rotation is attempted with existing shared test accounts.'])
for method in ['GET','POST']:
 op=f'{method} /api/cash-agent'
 add(op,'Cash deposit/withdrawal service is permanently disabled and must never create a movement.',[case('Historical cash-agent contract stays disabled',[step(op,{} if method=='POST' else None,status=410,checks=[eq('/error','CASH_AGENT_DISABLED'),typ('/message','string')])],deps=[])])
op='GET /api/communication/preferences'
add(op,'Each channel defaults to granted unless a nondeleted denied consent exists.',[read(op,'All four consent channel decisions agree with PostgreSQL',"SELECT jsonb_object_agg(ch,CASE WHEN EXISTS(SELECT 1 FROM konektag.communication_consents c WHERE c.user_id=$1 AND c.channel=ch AND c.status='denied' AND c.deleted_at IS NULL) THEN 'denied' ELSE 'granted' END) AS preferences FROM unnest(ARRAY['email','sms','push','whatsapp']) ch",[OWNER])])
op='PUT /api/communication/preferences'
add(op,'Preferences reject unknown channels and status before any persistent consent changes.',[bad(op,'Unknown channel is rejected atomically',{'preferences':[{'channel':'fax','status':'denied'}]},400,'Invalid channel or status: fax/denied',unchanged=['consents']),bad(op,'Array is mandatory',{},400,'Invalid payload: preferences array required',unchanged=['consents'])],['Grant/deny updates create durable audit/outbox records; positive lifecycle belongs to an explicitly disposable test account.'])
op='GET /api/communication/unsubscribe/{channel}'
add(op,'Unsubscribe requires a supported channel and signed user token before changing consent.',[bad(op,'Unsupported channel cannot revoke consent',None,400,'Invalid channel',path='/api/communication/unsubscribe/fax',unchanged=['consents']),bad(op,'Missing signed identity cannot revoke email',None,400,'Missing userId or token',path='/api/communication/unsubscribe/email',unchanged=['consents'])],['GET is a mutation for a valid link; successful signed unsubscribe is not read-only.'])
op='GET /api/profile/public'
add(op,'Private profile editor reads only the signed-in owner and ordered child objects.',[read(op,'Stored draft/public profile matches editor response','SELECT * FROM konektag.user_public_profiles WHERE user_id=$1',[OWNER],'/profile')])
op='PUT /api/profile/public'
# Restores visible business data through REST; generated audit/version timestamps cannot be rolled back across HTTP.
profilebody={'firstName':'REST','lastName':'${run.id}','title':'${run.id}','status':'draft','media':[{'url':'javascript:alert(1)'},{'url':'https://example.org/test.png','alt':'test'}],'externalLinks':[{'url':'javascript:alert(1)'}],'activities':['test activity']}
add(op,'Draft status hides public profile; non-HTTP links are dropped, children are replaced with bounded ordered lists.',[blocked('Replace and restore complete test public profile','Requires a disposable existing public-profile fixture; PUT deletes all children and no atomic rollback exists over HTTP.')],['Positive profile replacement deliberately blocked rather than overwriting an existing published profile.'])
op='GET /api/public/users'
add(op,'Public city listing exposes published profiles only and ranks shares before views.',[case('Without city no directory data is exposed',[step(op,checks=[eq('/profiles',[])])],deps=[]),read(op,'Designated published test profile is present and private draft absent','SELECT upp.user_id AS id,upp.title,upp.country,upp.city,u.username FROM konektag.user_public_profiles upp JOIN konektag.users u ON u.id=upp.user_id WHERE upp.user_id=$1 AND upp.status=\'published\'',[OWNER],'/profiles',path='/api/public/users?city=${publicProfile.city}&country=${publicProfile.country}',mode='contains',single=False)])
op='GET /api/public/users/{id}'
add(op,'Only a published public profile is exposed, using public fields instead of encrypted PII.',[read(op,'Public projection uses opted-in first/last names','SELECT user_id AS id,public_first_name AS "firstName",public_last_name AS "lastName",title,country,city FROM konektag.user_public_profiles WHERE user_id=$1 AND status=\'published\'',[OWNER],path='/api/public/users/${owner.userId}')])
op='GET /api/public/users/{id}/analytics'
add(op,'Only profile owner can inspect real view/share counts.',[read(op,'Real counters equal aggregate persisted profile events',"SELECT count(*) FILTER(WHERE event_type='view')::int AS views,count(*) FILTER(WHERE event_type='share')::int AS shares FROM konektag.user_public_profile_events WHERE profile_user_id=$1",[OWNER],path='/api/public/users/${owner.userId}/analytics'),case('Foreign authenticated test user sees no counters',[step(op,actor='stranger',status=403,path='/api/public/users/${owner.userId}/analytics',text=True,checks=[eq('','')])],actors=['owner','stranger'])])
op='POST /api/public/users/{id}/analytics'
add(op,'Only view/share events are accepted; an invalid event cannot change counters.',[bad(op,'Invalid event rejected before event insert',{'event':'purchase'},400,'INVALID_EVENT',path='/api/public/users/${owner.userId}/analytics',unchanged=['public-profile'])],['View deduplication and positive event persistence are not exercised by the invalid-event scenario.'])
for method in ['GET','POST']:
 op=f'{method} /api/users/search'
 add(op,'Search excludes the signed-in user and returns only live users, without encrypted PII.',[read(op,'Username lookup returns another designated test user, never self','SELECT id,username,country FROM konektag.users WHERE id=$1 AND deleted_at IS NULL',[CUSTOMER],actor='owner',single=False,mode='contains',path='/api/users/search?q=${customer.username}' if method=='GET' else None)],['Email/phone hash lookup variants are separate from username search.'])
 if method=='POST':SPECS[op]['scenarios'][0]['steps'][0]['body']={'query':'${customer.username}'}
# Taxonomy, independently compared to current PostgreSQL rather than canned arrays.
op='GET /api/marketplace/taxonomy/categories'
add(op,'Activity code is required; inactive/deleted categories never appear.',[read(op,'Restaurant categories and ordering equal live SQL','SELECT id,code,activity_code,name_i18n,sort_order FROM konektag.offer_categories WHERE activity_code=$1 AND is_active AND deleted_at IS NULL ORDER BY sort_order,code',['Restaurant'],'/categories',actor=None,single=False,mode='equal',path='/api/marketplace/taxonomy/categories?activityCode=Restaurant'),bad(op,'Unknown activity rejected',None,422,'INVALID_ACTIVITY_CODE',actor=None,unchanged=[])])
op='GET /api/marketplace/taxonomy/subcategories'
add(op,'Only active subcategories of the requested active parent are exposed.',[read(op,'Parent scoped active subcategories equal SQL','SELECT s.id,s.category_id,s.code,s.name_i18n,s.sort_order FROM konektag.offer_subcategories s JOIN konektag.offer_categories c ON c.id=s.category_id WHERE s.category_id=$1 AND s.is_active AND s.deleted_at IS NULL AND c.is_active AND c.deleted_at IS NULL ORDER BY s.sort_order,s.code',['${taxonomy.categoryId}'],'/subcategories',actor=None,path='/api/marketplace/taxonomy/subcategories?categoryId=${taxonomy.categoryId}',single=False,mode='equal'),bad(op,'Missing parent rejected',None,422,'CATEGORY_ID_REQUIRED',actor=None,unchanged=[])])
op='GET /api/geo/neighborhoods'
add(op,'Neighborhood suggestions are city/country scoped, trimmed, unique and drawn from published merchants.',[case('Missing geography returns no suggestions',[step(op,checks=[eq('/suggestions',[])])],deps=[]),read(op,'Known published test neighborhood is offered',"SELECT DISTINCT trim(mp.neighborhood) AS name FROM konektag.merchant_profiles mp WHERE mp.id=$1 AND mp.status='Published' AND nullif(trim(mp.neighborhood),'') IS NOT NULL",[MERCHANT],'/suggestions',resources=['merchant'],single=False,mode='equal',path='/api/geo/neighborhoods?country=${merchant.country}&city=${merchant.city}&q=${merchant.neighborhood}')],['Suggestion list can contain other matching public records; exact singleton scenario requires a unique test neighborhood.'])
# Signed device/offline commands exercise policy and payload validation, never bypass signatures.
op='GET /api/device-identity'
add(op,'Identity bootstrap validates UUID before key authority access.',[bad(op,'Invalid key UUID is refused',None,400,'INVALID_REQUEST',path='/api/device-identity?keyId=wrong')],['Successful authority-backed enrollment requires genuine test-device cryptographic proof.'])
op='POST /api/device-identity'
add(op,'Same-origin and bounded JSON checks precede certify/revoke operations.',[bad(op,'Missing origin cannot revoke devices',{'action':'revoke','deviceId':'00000000-0000-4000-8000-000000000007'},403,'ORIGIN_DENIED',origin=False),bad(op,'Non-JSON cannot enroll a device',None,415,'CONTENT_TYPE',headers={'Content-Type':'text/plain'})],['Valid certification/revocation requires a disposable device and real authority.'])
for kind in ['batch','envelope']:
 op=f'POST /api/offline/v1/{kind}'
 add(op,'Offline commands enforce same-origin, JSON, valid signed device payload before synchronization.',[bad(op,'Foreign origin cannot synchronize or issue an envelope',{},403,'ORIGIN_DENIED',origin=False),bad(op,'Malformed offline JSON cannot change state',None,400,'INVALID_OFFLINE_REQUEST',raw='{')],['Offline positive flow requires registered test devices, valid signing material and test-owned QR/payment envelopes.'])
# Legacy disabled routes assert the actual business decision, not routing.
for op,error in [('POST /api/growth/contents','CONTENT_LINK_RETIRED'),('GET /api/qr/confirm','QR_OTP_CHECKOUT_REQUIRED'),('GET /api/pay/payments/confirm','UNIFIED_PAYMENT_CHECKOUT_REQUIRED'),('POST /api/admin/mobile-money/acquisitions','UNIFIED_PAYMENT_CHECKOUT_REQUIRED')]:
 add(op,'Legacy path refuses obsolete workflow and preserves its specific frontend error contract.',[case('Obsolete workflow remains disabled',[step(op,{} if op.startswith('POST') else None,status=410,checks=[eq('/error',error)])],deps=[])])
op='POST /api/merchant/cards/sell'
add(op,'Individual card sales are retired in favor of a sale declaration with evidence.',[bad(op,'Even an authenticated agent must use sale declaration',{},410,'CARD_SALE_DECLARATION_REQUIRED')])
op='POST /api/cards/redeem'
add(op,'Redemption requires exactly sixteen digits and six PIN digits before card/ledger access.',[bad(op,'Invalid card number cannot be redeemed',{'number':'123','pin':'123456'},400,'INVALID'),bad(op,'Invalid PIN length cannot debit a card',{'number':'1111222233334444','pin':'123'},400,'INVALID')],['Positive redemption is irreversible and excluded without a disposable funded card.'])
op='POST /api/loyalty'
add(op,'Earning loyalty needs a stable business reference and a supported action.',[bad(op,'Unknown reward action earns no points',{'action':'make-money','reference':'${run.id}'},400,'Invalid action',unchanged=['loyalty'])],['No positive points grant is fabricated; business event evidence must exist.'])
op='GET /api/loyalty'
add(op,'Real loyalty point total comes from the signed-in user, with scoped transaction history.',[read(op,'Stored points and level are returned rather than silent zero fallback','SELECT points,level FROM konektag.loyalty_points WHERE user_id=$1',[OWNER])])
# Core transactions: reject malformed business commands before transaction creation.
for op,error,body in [('POST /api/transactions','INVALID_TRANSACTION',{'kind':'ORDER','lines':[{'label':'test','quantity':0}]}),('POST /api/transactions/{id}/transition','INVALID_COMMAND',{'expectedVersion':0,'command':'COMPLETE'}),('POST /api/merchant/operations/transactions','INVALID_MERCHANT_TRANSACTION',{'kind':'ORDER','lines':[]}),('POST /api/merchant/offline-mutations','INVALID_OFFLINE_MUTATION',{'expectedVersion':-1,'patch':{}}),('POST /api/catalog/checkout','INVALID_CART',{'cart':{'lines':[]}}),('POST /api/catalog/quote','INVALID_CART',{'lines':[]})]:
 path=op.split(' ',1)[1].replace('{id}','00000000-0000-4000-8000-000000000007')
 add(op,'Quantities, versions, request keys and merchant scope are validated before applying the command.',[bad(op,'Invalid business payload leaves transactions unchanged',body,422,error,path=path,unchanged=['core'])],['Positive transaction and replay flow requires current ERP-backed sellable product/pricing fixtures.'])
op='POST /api/wallet-authorizations/verify'
add(op,'OTP authorization is same-origin, UUID-bound and exactly six numeric digits.',[bad(op,'Incorrect OTP format does not authorize a debit',{'authorizationId':'00000000-0000-4000-8000-000000000007','otp':'12'},422,'INVALID_REQUEST'),bad(op,'Cross-origin OTP request denied',{},403,'CSRF_REJECTED',origin=False)],['Positive OTP verification needs a genuine unexpired test debit authorization.'])
# Email validation and actual provider acceptance evidence (not a mocked sendTemplate).
op='POST /api/onboarding/send-otp'
add(op,'Valid OTP must be present in Valkey and accepted by Resend; HTTP success alone is a regression.',[bad(op,'Invalid email cannot create or send an OTP',{'email':'invalid','locale':'fr'},422,None,actor=None,unchanged=[]),case('Resend acceptance is mandatory for real OTP success',[step(op,{'email':'${mail.recipient}','firstName':'REST','locale':'fr'},status=200,checks=[eq('/message','Email de confirmation envoyé')],resendEvidence='${mail.recipient}',valkeyOtp='${mail.recipient}')],deps=['Valkey','Resend'],actors=['owner'],mode='fixture-write')],['Known false-success bug is preserved in application code. This acceptance scenario must FAIL when Resend refuses delivery.'])
op='POST /api/email/send-verification'
add(op,'Already verified user cannot trigger another verification email.',[case('Verified test account stays unchanged',[step(op,{},'owner',400,[eq('/error','Email déjà vérifié')])],actors=['owner'],unchanged=['owner'],mode='validation',preconditions=[dict(q('SELECT email_verified FROM konektag.users WHERE id=$1',[OWNER]),equals=[{'email_verified':True}])])],['Resend acceptance for an unverified disposable test account is not exercised by this already-verified branch.'])
op='GET /api/email/verify'
add(op,'Verification rejects incomplete links before PostgreSQL or Keycloak changes.',[case('Missing token/user yields explicit invalid-link message',[step(op,status=400,text=True,checks=[dict(path='',matches='Lien de vérification invalide')])],deps=[])],['GET verifies email and can mutate Keycloak; positive one-time token flow needs a disposable unverified test user.'])
op='POST /api/test-email/send'
add(op,'All template variables are required and Resend must actually accept a test email.',[case('Missing template variables fail without a provider call',[step(op,{},status=400,checks=[eq('/error','Tous les champs sont requis')])],deps=[]),case('Successful response requires a matching real provider event',[step(op,{'nom':'REST','prenom':'Integration','email':'${mail.recipient}','pinCode':'000000'},checks=[eq('/success',True)],resendEvidence='${mail.recipient}')],deps=['Resend'],actors=['owner'],mode='fixture-write')])
# Payments/valuation: source currency, integer units and approved matrix evidence.
for method in ['GET','POST']:
 op=f'{method} /api/pay/points/value'
 payload={'currency':'EUR','amountMinor':250} if method=='POST' else None
 expected=[eq('/sourceCurrency','EUR'),dict(path='/proofHash',matches='^[a-f0-9]{64}$')]
 if method=='GET':expected += [eq('/pointCode','K'),eq('/currency','EUR'),eq('/pointValue',1)]
 else:expected += [eq('/eurAmountMinor',250),eq('/quantityK',3)]
 query=q("SELECT id::text AS \"authorityId\",points_k_matrix_version AS \"matrixVersion\" FROM konektag.exchange_rates WHERE from_currency='EUR' AND to_currency='EUR' AND points_k_status='APPROVED' AND rate=1 AND valid_from<=now() AND valid_to>now() ORDER BY points_k_matrix_version DESC,valid_from DESC,id DESC LIMIT 1")
 add(op,'One K equals EUR 1 with half-up integer rounding and a currently approved database authority.',[case('Parity and approved authority are independently checked',[step(op,payload,path=op.split(' ',1)[1]+'?currency=EUR' if method=='GET' else None,checks=expected,oracles=[dict(query,responsePath='',single=True,mode='subset')])],read=[dict(query,name='authority',minRows=1)]),case('Invalid currency/quantity is rejected',[step(op,{'currency':'EUR','amountMinor':0} if method=='POST' else None,path='/api/pay/points/value?currency=bad-code' if method=='GET' else None,status=400,checks=[eq('/error','INVALID_VALUATION_REQUEST' if method=='POST' else 'currency must be a 3-letter ISO code')])],deps=[])])
op='GET /api/pay/detected-country'
add(op,'Explicit country header takes precedence according to the deployed detection policy.',[case('Detection returns an ISO country or null, with a controlled edge header',[step(op,headers={'cf-ipcountry':'FR'},checks=[eq('/detectedCountry','FR')])],deps=[])],['Ingress may strip client country headers; a failed assertion documents that deployment policy instead of changing the API.'])
op='GET /api/pay/checkout/{token}'
add(op,'Unknown checkout token returns no payment order or raw persisted hash.',[case('Unissued random token is not a checkout',[step(op,status=404,path='/api/pay/checkout/${run.id}',checks=[eq('/error','Checkout not found')])])],['Positive public checkout data requires a disposable checkout token; none is manufactured from a stored hash.'])
op='POST /api/pay/checkout/{token}/confirm'
add(op,'Unsupported method is refused before checkout consumption.',[case('Unrecognized method cannot settle an order',[step(op,{'paymentMethod':'cash-untrusted'},status=400,path='/api/pay/checkout/${run.id}/confirm',checks=[eq('/error','Unsupported payment method')])],deps=[])],['No real settlement is triggered. Positive wallet/provider confirmation requires a dedicated unpaid test order.'])
op='POST /api/pay/checkout/resume'
add(op,'A missing/invalid resume secret cannot issue a new checkout token.',[case('Invalid secret remains unexchangeable',[step(op,{'resumeToken':'${run.id}'},status=404,checks=[eq('/error','Resume link is invalid or expired')])])],['Successful secret rotation consumes an existing resume token; positive test needs a disposable fixture.'])
op='POST /api/pay/checkout/{token}/mobile-money/pawapay/deposit'
add(op,'Unknown checkout must be refused before opening any external PawaPay payment page.',[case('Unknown checkout cannot create a deposit',[step(op,{},status=404,path='/api/pay/checkout/${run.id}/mobile-money/pawapay/deposit',checks=[typ('/error','string')])])],['A successful real deposit initiation is excluded without an explicitly sandboxed provider configuration.'])
op='GET /api/pay/checkout/{token}/mobile-money/pawapay/return'
add(op,'Browser return without deposit evidence redirects only; it cannot settle payment.',[case('Return URL contains original token and normalized language',[step(op,status=303,path='/api/pay/checkout/${run.id}/mobile-money/pawapay/return?lang=fr',responseHeaders={'location':'/fr/pay/checkout/pending\\?token=rest-test-'})],deps=[])],['Return containing a real depositId performs reconciliation and is not classified read-only.'])
op='POST /api/pay/pay-link'
add(op,'Payment-link slug is required before claim, wallet debit or receipt.',[bad(op,'Missing slug cannot consume any payment link',{},400,'slug required',unchanged=['orders'])],['Successful payment consumes money and a one-time link; deliberately excluded without disposable financial fixtures.'])
op='GET /api/pay/settlements'
add(op,'Merchant settlement access is owner/manager scoped, never trusted from request alone.',[bad(op,'Merchant id is mandatory',None,400,'merchantProfileId required'),case('Foreign merchant settlement scope is refused',[step(op,actor='owner',status=403,path='/api/pay/settlements?merchantProfileId=${foreignMerchant.id}',checks=[eq('/error','MERCHANT_SCOPE_FORBIDDEN')])],actors=['owner','stranger'],resources=['foreignMerchant'])],['Positive settlement summary is separately covered by the merchant settlement SQL scenario.'])
# QR personal-link verification and signed confirmation validation.
for op,error,path in [('GET /api/qr/personal-link','LINK_REQUIRED',None),('GET /api/qr/user-link-quote','RECIPIENT_REQUIRED',None)]:
 add(op,'A recipient or full personal link is required before valuation/lookup.',[bad(op,'Missing business reference is refused',None,400,error)],['Positive link/valuation flow requires dedicated valid intent and approved exchange-rate matrix.'])
op='POST /api/qr'
add(op,'The obsolete direct pay action is rejected in favor of signed confirmation.',[bad(op,'Direct pay action cannot bypass signed QR validation',{'action':'pay'},400,'Use /api/qr/request-confirmation')],['QR issuance is intentionally not conflated with successful payment verification.'])
op='POST /api/qr/request-confirmation'
add(op,'Payment amount and QR identity are mandatory before signed-QR and wallet processing.',[bad(op,'No amount cannot debit wallet',{},400,'Montant requis'),bad(op,'QR name mandatory',{'amount':100},400,'qrCodeName requis')],['Successful signed QR consumption, single use and ledger balancing need designated funded wallets and signed disposable QR.'])
op='POST /api/qr/personal-link'
add(op,'Personal link issuance persists a token hash and current owner/currency.',[blocked('Create disposable personal payment link','No revoke endpoint for unconsumed personal_link intents; requires explicit test-intent cleanup fixture rather than leaving payable links.')],['Issuance not attempted without cleanup for checkout_intents.'])
op='GET /api/qr/{id}'
add(op,'QR lookup uses persisted checkout intent, not a caller-supplied payment.',[blocked('Read test-owned signed checkout QR','Requires existing nonexpired signed QR fixture with checkout_intents ownership and provider-independent expected payload.')])
op='GET /api/qr/code'
add(op,'Short-code lookup must resolve an existing signed QR or return a domain not-found error.',[blocked('Resolve owned short code','Requires actual issued signed test QR; no fabricated short code is reported as a successful integration.')])


# Complete the catalog without importing/running any application or test module.
# A binding supplies real, existing business data and its expected projection;
# it never supplies an alternative handler or service.
OUT=ROOT/'tests/rest/live-draft'
def closure(entry):
 seen=set(); todo=[entry]
 while todo:
  filename=todo.pop()
  if filename in seen or not (ROOT/filename).is_file():continue
  seen.add(filename); text=(ROOT/filename).read_text()
  for spec in re.findall(r'''(?:from\s*|import\s*\(|import\s*)['"]([^'"]+)['"]''',text):
   if not spec.startswith('.'):continue
   target=(ROOT/filename).parent/spec
   candidates=[target,target.with_suffix('.ts'),target.with_suffix('.mts'),target/'index.ts']
   for candidate in candidates:
    if candidate.is_file():
     todo.append(str(candidate.resolve().relative_to(ROOT.resolve())));break
 return sorted(seen)
SERVICE_RULES={
 'PostgreSQL':r'(?:/database/pool\.ts$|/database/connection\.ts$)',
 'Valkey':r'(?:redis-adapter|rate-limit)',
 'Keycloak':r'(?:keycloak-adapter|keycloak-bearer)',
 'ERPNext/Frappe':r'(?:erpnext|frappe)',
 'MinIO/S3':r'(?:minio|s3-)',
 'Resend':r'(?:email-service|resend)',
 'Dify':r'dify',
 'Stripe':r'(?:stripe|provider-configuration)',
 'PawaPay':r'(?:pawapay|provider-configuration)',
 'Directus':r'directus',
 'Mautic':r'mautic',
 'Postiz':r'postiz',
 'GeoIP':r'geoip',
 'IndexNow':r'indexnow',
 'Public site (IndexNow key file)':r'merchant-discovery-service',
 'Google Places':r'/photo/\[id\]\.ts$',
}
def dependencies(entry):
 files=closure(entry); evidence={}; variables=collections.defaultdict(list)
 for filename in files:
  text=(ROOT/filename).read_text()
  for name,pattern in SERVICE_RULES.items():
   if re.search(pattern,filename,re.I):evidence.setdefault(name,[]).append(filename)
  for variable in re.findall(r'process\.env\.([A-Z][A-Z0-9_]*)',text):variables[variable].append(filename)
  for name,pattern in [('Resend',r'api\.resend\.com'),('Directus',r'DIRECTUS_|directus'),('Stripe',r"from ['\"]stripe['\"]"),('PawaPay',r'PAWAPAY_'),('MinIO/S3',r'@aws-sdk/client-s3'),('PostgreSQL',r"from ['\"]pg['\"]"),('Valkey',r"from ['\"]redis['\"]"),('ERPNext/Frappe',r'ERPNEXT_|FRAPPE_')]:
   if re.search(pattern,text):evidence.setdefault(name,[]).append(filename)
 return {'services':{k:sorted(set(v)) for k,v in sorted(evidence.items())},
         'referencedEnvironment':{k:sorted(set(v)) for k,v in sorted(variables.items())},
         'sourceFiles':{f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files}}

catalog=[]; requirements={}; source_index={}
for op,o in sorted(OPS.items()):
 key=hashlib.sha256(op.encode()).hexdigest()[:12]
 definition=SPECS.get(op)
 # Keep one already-authored scenario with an actual HTTP step. Prefer a
 # business observation over malformed transport or an unconditional block.
 candidates=[s for s in (definition or {}).get('scenarios',[]) if s.get('steps') and not s.get('blocked')]
 selected=next((s for s in candidates if any(st.get('oracles') or st.get('resendEvidence') for st in s['steps'])),None)
 if selected is None:selected=next((s for s in candidates if s.get('mode')=='validation'),None)
 if selected is None:selected=next(iter(candidates),None)
 if selected:
  definition={**definition,'scenarios':[selected]}
  requirements[op]={'kind':'authored','actors':selected.get('actors',[]),'resources':selected.get('resources',[])}
 else:
  method,route=op.split(' ',1)
  definition={'operation':op,'domain':o['domain'],'source':o['source'],
    'sourceSha256':hashlib.sha256((ROOT/o['source']).read_bytes()).hexdigest(),
    'rule':'Execute the real operation on a designated existing test fixture; compare business content and, for a command, its persisted effect.',
    'scenarios':[{'name':f'{op}: real fixture business projection or persisted command',
                  'fixtureCase':key,'dependencies':[],'steps':[{'method':method,'path':route,'status':'${cases.'+key+'.expected.status}', 'assertions':[{'path':'','subset':'${cases.'+key+'.expected.body}'}]}]}],
    'unexercised':['Other inputs, roles and state transitions are outside this single representative scenario.']}
  requirements[op]={'kind':'fixture-bound','case':key,'pathParameters':re.findall(r'\{([^}]+)\}',route),
    'required':['testOnly','owner','request','expected.status','expected.body']+(['oracles'] if method!='GET' else []),
    'requestFields':['params','query','body (JSON) or raw (signed webhook) or form','headerEnv (credential/signature environment names)'],
    'optional':['actor','preconditions','cleanup']}
 traced=dependencies(o['source'])
 definition.update(method=o['method'],path=o['path'],dependencies=sorted(traced['services']),sourceFiles=list(traced['sourceFiles']))
 for filename,digest in traced['sourceFiles'].items():
  if filename not in source_index:
   source_index[filename]={'sha256':digest,'environment':sorted(k for k,v in traced['referencedEnvironment'].items() if filename in v),
     'services':sorted(k for k,v in traced['services'].items() if filename in v),
     'httpReferences':sorted(set(re.findall(r'https?://[^\s\"\'`<>]+',(ROOT/filename).read_text())))}
 catalog.append(definition)

# Auth middleware is a separate conservative dependency set: its branches depend
# on the supplied credential and public-route classification, not only the route.
shared=dependencies('src/api/middleware/security.ts')
(OUT/'dependencies.json').write_text(json.dumps({'method':'Conservative transitive import closure, including type imports; referenced variables are not all mandatory at runtime. No service contacted.', 'files':source_index,'sharedMiddleware':shared},ensure_ascii=False,indent=2)+'\n')
(OUT/'scenarios.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
(OUT/'catalog.json').write_text(json.dumps({'schemaVersion':1,'operations':len(catalog),
 'files':['tests/rest/live-draft/scenarios.json'],'dependencies':'tests/rest/live-draft/dependencies.json'},ensure_ascii=False,indent=2)+'\n')
(OUT/'oracles.json').write_text(json.dumps({'guards':GUARDS,'snapshots':SNAP},ensure_ascii=False,indent=2)+'\n')
# Exact inputs, including every variable referenced by retained authored steps.
for definition in catalog:
 op=definition['operation']
 if requirements[op]['kind']=='authored':
  scenario=definition['scenarios'][0]
  related=[scenario]+[GUARDS[r] for r in scenario.get('resources',[])]+[SNAP[r] for r in scenario.get('unchanged',[])]
  requirements[op]['variables']=sorted(k for k in set(re.findall(r'\$\{([^}]+)\}',json.dumps(related))) if k != 'run.id' and not k.startswith('captured.'))
  requirements[op]['configuration']={'postgresql.urlEnv':bool(scenario.get('actors') or scenario.get('resources') or scenario.get('unchanged') or scenario.get('read') or any(st.get('oracles') for st in scenario['steps'])), 'allowFixtureWrites':scenario.get('mode')=='fixture-write', 'resend.apiKeyEnv + resend.testRecipients':any(st.get('resendEvidence') for st in scenario['steps']), 'valkey.urlEnv':any(st.get('valkeyOtp') for st in scenario['steps']), 'internalTokenEnv':any(st.get('internalToken') for st in scenario['steps'])}
(OUT/'fixture-requirements.json').write_text(json.dumps(requirements,ensure_ascii=False,indent=2)+'\n')
