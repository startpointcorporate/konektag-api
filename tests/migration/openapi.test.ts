import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { routes } from '../../src/api/registry';
it('documents every exported REST operation without inventing routes',()=>{
  const spec=parse(readFileSync('docs/openapi.yaml','utf8'));
  expect(spec.openapi).toBe('3.1.0');
  expect(Object.keys(spec.paths).sort()).toEqual(routes.map(r=>r.path).sort());
  const ids:string[]=[];
  for(const r of routes)for(const method of r.methods){
    const operation=spec.paths[r.path][method.toLowerCase()];expect(operation).toBeDefined();ids.push(operation.operationId);
    for(const key of r.keys)expect(operation.parameters).toContainEqual(expect.objectContaining({name:key,in:'path',required:true}));
  }
  expect(new Set(ids).size).toBe(408);
});

it('documents Keycloak OAuth2 authorization code for Swagger without replacing existing schemes',()=>{
  const spec=parse(readFileSync('docs/openapi.yaml','utf8'));
  const oauth=spec.components.securitySchemes.keycloakOAuth;
  expect(oauth.type).toBe('oauth2');
  expect(oauth.flows.authorizationCode.authorizationUrl).toBe('https://login.konektag.eu/realms/konektag/protocol/openid-connect/auth');
  expect(oauth.flows.authorizationCode.tokenUrl).toBe('https://login.konektag.eu/realms/konektag/protocol/openid-connect/token');
  expect(spec.components.securitySchemes.session).toBeDefined();
  expect(spec.components.securitySchemes.userApiKey).toBeDefined();
  expect(spec.components.securitySchemes.bearer).toBeDefined();
  expect(spec.paths['/api/auth/me'].get.security).toContainEqual({keycloakOAuth:[]});
  expect(spec.paths['/api/countries'].get.security).toContainEqual({keycloakOAuth:[]});
});

it('documents the published marketplace listing and facets contract',()=>{
  const {paths}=parse(readFileSync('docs/openapi.yaml','utf8'));
  const list=paths['/api/public/marketplace/merchants'].get;
  expect(list.security).toEqual([]);
  expect(list.parameters.find((p:any)=>p.name==='sort').schema).toEqual({type:'string',enum:['name','distance'],default:'name'});
  expect(list.parameters.find((p:any)=>p.name==='limit').schema.maximum).toBe(50);
  expect(list.responses['200'].content['application/json'].schema.required).toContain('sort');
  expect(list.responses['503'].content['application/json'].schema.properties.error.const).toBe('PROJECTION_UNAVAILABLE');
  expect(paths['/api/public/marketplace/facets'].get.responses['200'].content['application/json'].schema.properties.countries.items.properties.cities.items.required).toContain('id');
});
