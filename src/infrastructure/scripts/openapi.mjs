import ts from 'typescript';
import { readFile, writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { records } from './routes.mjs';
import { documentMarketplace } from './marketplace-openapi.mjs';
const unique = values => [...new Set(values)];
function visit(node,fn) { fn(node); ts.forEachChild(node,child=>visit(child,fn)); }
function objectSchema(node) {
  if (!node) return {};
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return {type:'string',const:node.text};
  if (ts.isNumericLiteral(node)) return {type:'number',const:Number(node.text)};
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return {type:'boolean',const:node.kind===ts.SyntaxKind.TrueKeyword};
  if (node.kind === ts.SyntaxKind.NullKeyword) return {type:'null'};
  if (ts.isArrayLiteralExpression(node)) return {type:'array',items:node.elements.length?objectSchema(node.elements[0]):{}};
  if (ts.isObjectLiteralExpression(node)) {
    const properties = {};
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) properties[property.name.getText().replace(/^['"]|['"]$/g,'')] = objectSchema(property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) properties[property.name.text] = {};
    }
    return {type:'object',properties};
  }
  if (ts.isConditionalExpression(node)) return {anyOf:[objectSchema(node.whenTrue),objectSchema(node.whenFalse)]};
  return {};
}
function zodSchema(node,constants,seen=new Set()) {
  if (!node) return {};
  if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) return zodSchema(constants.get(node.text),constants,new Set([...seen,node.text]));
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return {};
  const method=node.expression.name.text;
  const args=node.arguments;
  const previous=node.expression.expression;
  if (method==='object' && args[0] && ts.isObjectLiteralExpression(args[0])) {
    const properties={},required=[];
    for(const p of args[0].properties) if(ts.isPropertyAssignment(p)) {
      const key=p.name.getText().replace(/^['"]|['"]$/g,'');properties[key]=zodSchema(p.initializer,constants);
      if(!/\.(optional|default|partial)\(/.test(p.initializer.getText())) required.push(key);
    }
    return {type:'object',properties,...(required.length?{required}:{} )};
  }
  if(['string','number','boolean','date','bigint'].includes(method)) return {type:method==='date'?'string':method==='bigint'?'integer':method,...(method==='date'?{format:'date-time'}:{})};
  if(method==='enum' && args[0] && ts.isArrayLiteralExpression(args[0])) return {type:'string',enum:args[0].elements.filter(ts.isStringLiteral).map(x=>x.text)};
  if(method==='literal') return objectSchema(args[0]);
  if(method==='array') return {type:'array',items:zodSchema(args[0],constants)};
  if(method==='union' && args[0] && ts.isArrayLiteralExpression(args[0])) return {anyOf:args[0].elements.map(x=>zodSchema(x,constants))};
  const schema=zodSchema(previous,constants,seen);
  if(method==='int') schema.type='integer';
  if(method==='email') schema.format='email';
  if(method==='uuid') schema.format='uuid';
  if(method==='url') schema.format='uri';
  if(method==='nullable') return {anyOf:[schema,{type:'null'}]};
  if(method==='min' && args[0] && ts.isNumericLiteral(args[0])) schema[schema.type==='string'?'minLength':schema.type==='array'?'minItems':'minimum']=Number(args[0].text);
  if(method==='max' && args[0] && ts.isNumericLiteral(args[0])) schema[schema.type==='string'?'maxLength':schema.type==='array'?'maxItems':'maximum']=Number(args[0].text);
  return schema;
}
const securityCode = await readFile('src/api/middleware/security.ts','utf8');
function array(name) {const text=securityCode.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1]||'';return [...text.matchAll(/'([^']+)'/g)].map(m=>m[1]);}
const publicPrefixes=array('PUBLIC_PREFIXES'),publicExact=array('PUBLIC_EXACT_PATHS'),protectedPrefixes=array('PROTECTED_PREFIXES');
const paths={};
for(const record of records) {
  const ast=ts.createSourceFile(record.file,record.code,ts.ScriptTarget.Latest,true);
  const constants=new Map();
  visit(ast,n=>{if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&n.initializer)constants.set(n.name.text,n.initializer);});
  paths[record.path]??={};
  for(const method of record.methods) {
    const handler=constants.get(method);
    const code=handler?.getText(ast) || record.code;
    const params=record.keys.map(name=>({name,in:'path',required:true,schema:{type:'string'}}));
    for(const name of unique([...code.matchAll(/searchParams\.(?:get|getAll|has)\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]))) params.push({name,in:'query',schema:{type:'string'}});
    const headers=unique([...code.matchAll(/headers\.get\(['"]([^'"]+)['"]\)/g)].map(m=>m[1])).filter(n=>!['authorization','cookie'].includes(n.toLowerCase()));
    params.push(...headers.map(name=>({name,in:'header',schema:{type:'string'}})));
    const responseSchemas=[];const bodySchemas=[];
    if(handler) visit(handler,node=>{
      if(ts.isCallExpression(node)) {
        if(node.expression.getText(ast)==='JSON.stringify' && node.arguments[0]) {const s=objectSchema(node.arguments[0]);if(s.type) responseSchemas.push(s);}
        if(ts.isPropertyAccessExpression(node.expression)&&['safeParse','parse'].includes(node.expression.name.text)) {
          const schema=zodSchema(node.expression.expression,constants);
          if(Object.keys(schema).length) bodySchemas.push(schema);
        }
      }
    });
    const statuses=unique([...code.matchAll(/status\s*:\s*([1-5]\d\d)/g)].map(m=>m[1]));
    if(handler)visit(handler,node=>{
      if(ts.isCallExpression(node)){
        const name=node.expression.getText(ast);
        const status=(name==='Response.redirect'||/^(json|visibilityJson|error)$/.test(name))?node.arguments[1]:undefined;
        if(status&&ts.isNumericLiteral(status)&&/^[1-5]\d\d$/.test(status.text))statuses.push(status.text);
      }
    });
    if(!statuses.some(s=>s.startsWith('2')))statuses.unshift('200');
    const errors=[];
    if(handler)visit(handler,node=>{
      if(ts.isPropertyAssignment(node)&&['error','code'].includes(node.name.getText(ast).replace(/^['"]|['"]$/g,''))&&ts.isStringLiteral(node.initializer))errors.push(node.initializer.text);
    });
    const dedupe=schemas=>[...new Map(schemas.map(s=>[JSON.stringify(s),s])).values()];
    const candidates=dedupe(responseSchemas);
    const responseSchema=candidates.length===1?candidates[0]:candidates.length?{anyOf:candidates}:{};
    const mediaTypes=unique([...code.matchAll(/['"](?:Content-Type|content-type)['"]\s*:\s*['"]([^'"]+)['"]/g)].map(m=>m[1].split(';')[0]));
    if(!mediaTypes.length)mediaTypes.push('application/json');
    const responses=Object.fromEntries(unique(statuses).map(status=>[status,{
      description:status.startsWith('2')?'Response from the migrated handler':'Error or redirect from the migrated handler',
      ...((status==='204'||status.startsWith('3'))?{}:{content:Object.fromEntries(mediaTypes.map(type=>[type,{schema:type==='application/json'?responseSchema:{}}]))})
    }]));
    responses.default={description:'Additional responses from authentication, authorization, KYC, idempotency or the shared application service. See x-source and x-error-codes.'};
    const middlewarePath=record.canonicalPath || record.path;
    const middlewarePublic=publicExact.includes(middlewarePath)||publicPrefixes.some(p=>middlewarePath.startsWith(p))||!protectedPrefixes.some(p=>middlewarePath.startsWith(p));
    const handlerAuth=/locals(?:\??\.)?\.user|locals\.user|!user|requireAdmin|requireAuth|isAdmin|authorization/i.test(code);
    const op={operationId:method.toLowerCase()+'_'+record.path.replace(/[^a-zA-Z0-9]+/g,'_').replace(/_$/,''),summary:method+' '+record.path,tags:[record.path.split('/')[2]],description:'Existing Konektag operation. Handler and shared services preserve validation, authorization, error responses and business rules. '+(middlewarePublic?'This path is public at the general middleware level; any handler-specific checks still apply.':'Session/API authentication and account restrictions run before the handler.'),parameters:params,responses,security:middlewarePublic&&!handlerAuth?[]:[{session:[]},{userApiKey:[]},{bearer:[]},{keycloakOAuth:[]}],'x-source':record.file,'x-error-codes':errors,'x-response-schema-scope':'Literal response variants found in handler; computed service/database fields remain unconstrained.'};
    if(/request\.json\(/.test(code))op.requestBody={required:true,content:{'application/json':{schema:dedupe(bodySchemas)[0]||{}}}};
    if(/request\.formData\(/.test(code))op.requestBody={required:true,content:{'multipart/form-data':{schema:{type:'object',additionalProperties:true}}}};
    paths[record.path][method.toLowerCase()]=op;
  }
}
documentMarketplace(paths);
const spec={openapi:'3.1.0',info:{title:'Konektag API',version:'0.1.0',description:'REST contracts migrated from konetag@c25c1ac5d42d0e173b9dec28c950617d109d0530. YAML is the sole specification source; runtime JSON is generated at build time. Unconstrained schemas identify computed fields, not additional capabilities.'},servers:[{url:'/'}],components:{securitySchemes:{session:{type:'apiKey',in:'cookie',name:'konektag_access_token'},userApiKey:{type:'apiKey',in:'header',name:'Authorization',description:'Existing protocol: token <api-key>:<api-secret>. Account roles and scopes remain enforced.'},bearer:{type:'http',scheme:'bearer',description:'Route-specific merchant or internal bearer credential; not interchangeable with a user API key.'},keycloakOAuth:{type:'oauth2',description:'Keycloak user authentication via Authorization Code with PKCE S256; the authenticated user must exist in Konektag.',flows:{authorizationCode:{authorizationUrl:'https://login.konektag.eu/realms/konektag/protocol/openid-connect/auth',tokenUrl:'https://login.konektag.eu/realms/konektag/protocol/openid-connect/token',scopes:{}}}}}},paths};
await writeFile('docs/openapi.yaml',stringify(spec,{lineWidth:120}));
console.log(`Documented ${Object.keys(paths).length} paths and ${records.reduce((sum,r)=>sum+r.methods.length,0)} operations`);
