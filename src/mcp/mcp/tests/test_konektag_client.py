"""Regression checks for shared Konektag backend credentials and CPM tools."""
import asyncio
import pytest
import httpx
from konektag_client import KonektagClient
from cpm_client import CPMClient


def test_requires_existing_api_credentials(monkeypatch):
    monkeypatch.setenv("KONEKTAG_URL", "https://www.konektag.eu")
    monkeypatch.delenv("KONEKTAG_API_KEY", raising=False)
    monkeypatch.delenv("KONEKTAG_API_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="CREDENTIALS_MISSING"):
        KonektagClient()


def test_rejects_insecure_backend(monkeypatch):
    monkeypatch.setenv("KONEKTAG_URL", "http://www.konektag.eu")
    with pytest.raises(RuntimeError, match="URL_INVALID"):
        KonektagClient()


def test_shared_auth_header_and_cpm_filter(monkeypatch):
    monkeypatch.setenv("KONEKTAG_URL", "https://www.konektag.eu")
    monkeypatch.setenv("KONEKTAG_API_KEY", "test-key")
    monkeypatch.setenv("KONEKTAG_API_SECRET", "test-secret")
    captured = {}
    class FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
        async def request(self, method, url, **kwargs):
            captured.update(method=method, url=url, **kwargs)
            return httpx.Response(200, json={"mappings": [
                {"channel": "facebook", "target_country": "FR", "billing_company": "Konektag France"},
                {"channel": "facebook", "target_country": "CG", "billing_company": "Konektag Congo"}
            ]}, request=httpx.Request(method, url))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: FakeClient())
    result = asyncio.run(CPMClient().list("facebook", "FR", "Konektag France"))
    assert len(result["mappings"]) == 1
    assert captured["headers"]["Authorization"] == "token test-key:test-secret"
    assert captured["url"] == "https://www.konektag.eu/api/admin/boost-pricing"


def test_rejects_external_paths(monkeypatch):
    monkeypatch.setenv("KONEKTAG_URL", "https://www.konektag.eu")
    monkeypatch.setenv("KONEKTAG_API_KEY", "test-key")
    monkeypatch.setenv("KONEKTAG_API_SECRET", "test-secret")
    with pytest.raises(ValueError, match="INVALID_KONEKTAG_API_PATH"):
        asyncio.run(KonektagClient().request("GET", "https://example.com/api/admin/boost-pricing"))
