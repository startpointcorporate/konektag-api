"""Coverage and real local OAuth transport checks; never connects to business systems."""
import ast
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = json.loads((ROOT / 'docs/mcp-tools.json').read_text())

@pytest.mark.parametrize('service', ['mcp', 'mcp-m365', 'mcp-unipile'])
def test_tool_contracts_unchanged(service):
    module = ast.parse((ROOT / 'src/mcp' / service / 'server.py').read_text())
    expected = {t['name']: t for t in TOOLS if t['service'] == service}
    actual = {n.name:n for n in module.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
              and any(isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == 'tool' for d in n.decorator_list)}
    assert actual.keys() == expected.keys()
    for name, node in actual.items():
        assert ast.unparse(node.args) == expected[name]['signature']
        assert hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest() == expected[name]['ast_sha256']

@pytest.mark.parametrize('service', ['mcp', 'mcp-m365', 'mcp-unipile'])
def test_oauth_discovery_and_unauthenticated_transport(service, tmp_path):
    # Synthetic local configuration, isolated OAuth storage; no production credentials.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    prefix = {'mcp':'','mcp-m365':'/m365','mcp-unipile':'/unipile'}[service]
    config = {**os.environ, 'MCP_HOST':'127.0.0.1', 'MCP_PORT':str(port),
              'UNIPILE_MCP_HOST':'127.0.0.1', 'UNIPILE_MCP_PORT':str(port),
              'MCP_PUBLIC_URL':origin+prefix, 'OAUTH_STORE_DIR':str(tmp_path/'oauth'),
              'FASTMCP_HOME':str(tmp_path/'fastmcp'), 'HOME':str(tmp_path),
              'OAUTH_AUTHORIZE_URL':'https://identity.example.invalid/authorize',
              'OAUTH_TOKEN_URL':'https://identity.example.invalid/token',
              'OAUTH_JWKS_URI':'https://identity.example.invalid/jwks',
              'OAUTH_ISSUER':'https://identity.example.invalid', 'OAUTH_AUDIENCE':'test',
              'OAUTH_CLIENT_ID':'local-test', 'OAUTH_CLIENT_SECRET':'local-test-only-not-a-real-secret',
              'FRAPPE_URL':'https://erp.example.invalid', 'FRAPPE_API_KEY':'local-test', 'FRAPPE_API_SECRET':'local-test',
              'M365_CLIENT_ID':'local-test', 'M365_TENANT_ID':'local-test', 'M365_MAILBOX':'test@example.invalid'}
    with (tmp_path/'startup.log').open('w+') as log:
        process = subprocess.Popen([sys.executable,'server.py'],cwd=ROOT/'src/mcp'/service,env=config,stdout=log,stderr=log)
        try:
            with httpx.Client(trust_env=False,timeout=2) as client:
                deadline=time.monotonic()+30
                while True:
                    if process.poll() is not None:
                        log.seek(0);pytest.fail(log.read())
                    try:
                        discovery=client.get(origin+'/.well-known/oauth-authorization-server'+prefix)
                        if discovery.status_code==200:break
                    except httpx.TransportError:pass
                    if time.monotonic()>deadline:
                        log.seek(0);pytest.fail(log.read())
                    time.sleep(.1)
                assert discovery.json()['authorization_endpoint'].startswith(origin)
                response=client.post(origin+'/mcp',headers={'Accept':'application/json, text/event-stream'},json={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'smoke','version':'1'}}})
                assert response.status_code == 401
                assert 'www-authenticate' in response.headers
        finally:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
