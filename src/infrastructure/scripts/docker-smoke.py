#!/usr/bin/env python3
"""Run built validation images without external networking; remove only test containers."""
import json
from pathlib import Path
import subprocess

DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
created, images = [], []

def run(*args):
    return subprocess.check_output(DOCKER + list(args), text=True, timeout=30).strip()

try:
    for service in ['api', 'mcp', 'mcp-m365', 'mcp-unipile']:
        image = 'konektag-' + service + ':validation'
        images.append({'image': image, 'id': run('image', 'inspect', '--format', '{{.Id}}', image)})
        env = {'NODE_ENV': 'test', 'DATABASE_URL': 'postgresql://127.0.0.1:9/unavailable',
               'REDIS_URL': 'redis://127.0.0.1:9'} if service == 'api' else {
            'MCP_PUBLIC_URL': 'http://localhost:8000',
            'OAUTH_AUTHORIZE_URL': 'https://identity.example.invalid/authorize',
            'OAUTH_TOKEN_URL': 'https://identity.example.invalid/token',
            'OAUTH_JWKS_URI': 'https://identity.example.invalid/jwks',
            'OAUTH_ISSUER': 'https://identity.example.invalid', 'OAUTH_AUDIENCE': 'test',
            'OAUTH_CLIENT_ID': 'test', 'OAUTH_CLIENT_SECRET': 'local-test-only',
            'FRAPPE_URL': 'https://erp.example.invalid', 'FRAPPE_API_KEY': 'test',
            'FRAPPE_API_SECRET': 'test', 'M365_CLIENT_ID': 'test',
            'M365_TENANT_ID': 'test', 'M365_MAILBOX': 'test@example.invalid'}
        args = ['run', '-d', '--network', 'none']
        for key, value in env.items():
            args.extend(['-e', key + '=' + value])
        container = run(*args, image)
        created.append(container)
        try:
            if service == 'api':
                code = """
let ready=false;
for(let i=0;i<100;i++){
 try{const r=await fetch('http://127.0.0.1:3000/livez');if(r.ok){ready=true;break}}catch{}
 await new Promise(r=>setTimeout(r,100));
}
if(!ready)throw Error('API startup failed');
const spec=await(await fetch('http://127.0.0.1:3000/openapi.json')).json();
if(Object.keys(spec.paths).length!==305)throw Error('OpenAPI coverage failed');
if((await fetch('http://127.0.0.1:3000/api/account/balance')).status!==401)throw Error('Authentication failed');
console.log('API image: startup, OpenAPI and anonymous denial passed');
"""
                print(run('exec', container, 'node', '--input-type=module', '-e', code), flush=True)
            else:
                code = """
import httpx,time
with httpx.Client(trust_env=False,timeout=1) as client:
 for i in range(100):
  try:
   response=client.get('http://127.0.0.1:8000/.well-known/oauth-authorization-server')
   if response.status_code==200:break
  except httpx.TransportError:pass
  time.sleep(.1)
 else:raise RuntimeError('MCP startup failed')
 response=client.post('http://127.0.0.1:8000/mcp',headers={'Accept':'application/json, text/event-stream'},
                      json={'jsonrpc':'2.0','id':1,'method':'initialize'})
 assert response.status_code==401
 print('OAuth discovery and anonymous denial passed')
"""
                print(service + ': ' + run('exec', container, 'python', '-c', code), flush=True)
        except Exception:
            print(run('logs', container))
            raise
    Path('docs/images.json').write_text(json.dumps(images, indent=2) + '\n')
finally:
    for container in created:
        subprocess.run(DOCKER + ['rm', '-f', container], stdout=subprocess.DEVNULL, check=False)
