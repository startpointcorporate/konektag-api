import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from postiz_client import PostizClient, PostizError, date_range, days_parameter, identifier


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('POSTIZ_API_KEY', 'test-secret-never-output')
    return PostizClient()


def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(handler), **kw))


@pytest.mark.parametrize('value', [0, 91, True, '7', 1.5])
def test_days(value):
    with pytest.raises(ValueError): days_parameter(value)


@pytest.mark.parametrize('value', ['', '../posts', 'a/b', 'a?x=1', 'x'*129])
def test_identifier(value):
    with pytest.raises(ValueError): identifier(value)


@pytest.mark.parametrize('start,end', [('2026-07-01','2026-07-02'),
    ('2026-07-01T00:00:00Z','2026-08-02T00:00:00Z'),
    ('2026-07-02T00:00:00Z','2026-07-01T00:00:00Z')])
def test_dates(start, end):
    with pytest.raises(ValueError): date_range(start, end)


def test_missing_key(monkeypatch):
    monkeypatch.delenv('POSTIZ_API_KEY', raising=False)
    with pytest.raises(PostizError, match='POSTIZ_API_KEY'): PostizClient()


@pytest.mark.parametrize('code', [301,401,403,404,429,500])
def test_http_errors(client, monkeypatch, code):
    transport(monkeypatch, lambda req: httpx.Response(code, text='test-secret-never-output'))
    with pytest.raises(PostizError, match=f'HTTP {code}') as error:
        asyncio.run(client.post_analytics('abc', 7))
    assert 'test-secret' not in str(error.value)


def test_paths_and_missing_metrics(client, monkeypatch):
    calls=[]
    def handler(req):
        calls.append(req)
        assert req.headers['Authorization'] == 'test-secret-never-output'
        return httpx.Response(200, json={'views': None})
    transport(monkeypatch, handler)
    for coro in [client.list_posts('2026-07-01T00:00:00Z','2026-07-02T00:00:00Z'),
                 client.platform_analytics('integration',7), client.post_analytics('post',30)]:
        result=asyncio.run(coro)
        assert result['data'] == {'views': None}
        assert result['completeness']=='not_verified'
    assert [r.url.path for r in calls] == ['/api/public/v1/posts','/api/public/v1/analytics/integration','/api/public/v1/analytics/post/post']
    assert calls[1].url.params['date']=='7'
    assert calls[0].url.params['startDate']=='2026-07-01T00:00:00Z'


@pytest.mark.parametrize('mode', ['timeout','invalid','oversize'])
def test_transport_failures(client, monkeypatch, mode):
    def handler(req):
        if mode=='timeout': raise httpx.ReadTimeout('test-secret-never-output')
        return httpx.Response(200, content=b'x' * (2_000_001 if mode=='oversize' else 1))
    transport(monkeypatch,handler)
    with pytest.raises(PostizError): asyncio.run(client.post_analytics('post',7))


def test_mcp_access_denied(server_module):
    server = server_module
    async def check():
        app=server.mcp.http_app()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='https://example.invalid') as http:
                for tool in ['crm_create_lead','crm_update_lead','erp_create_company','erp_list_companies','erp_list_items','erp_get_item','erp_create_item','erp_update_item','postiz_list_posts',
                             'postiz_platform_analytics','postiz_post_analytics']:
                    for headers in [{},{'Authorization':'Bearer invalid'}]:
                        response=await http.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':tool,'arguments':{}}})
                        assert response.status_code==401
    asyncio.run(check())
