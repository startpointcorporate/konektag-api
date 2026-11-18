import asyncio

import httpx
import pytest

from erpnext_client import ERPClient


SITES = {
    "EUROPE": "eu.erp.example.invalid",
    "KONEKTAG_CG": "cg.erp.example.invalid",
    "LIBAN": "lb.erp.example.invalid",
}


@pytest.fixture
def configured_sites(monkeypatch):
    for site, host in SITES.items():
        monkeypatch.setenv(f"MARKETPLACE_FRAPPE_{site}_URL", f"https://{host}")
        monkeypatch.setenv(f"MARKETPLACE_FRAPPE_{site}_API_KEY", f"key-{site}")
        monkeypatch.setenv(f"MARKETPLACE_FRAPPE_{site}_API_SECRET", f"secret-{site}")


@pytest.mark.parametrize("site,host", SITES.items())
def test_each_selector_uses_only_its_configured_host(configured_sites, monkeypatch, site, host):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"data": {"name": "COMPANY"}})

    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient",
                        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = asyncio.run(ERPClient(site).get("Company", "COMPANY"))
    assert result["name"] == "COMPANY"
    assert [request.url.host for request in calls] == [host]
    assert calls[0].headers["Authorization"] == f"token key-{site}:secret-{site}"


def test_invalid_or_unconfigured_site_never_falls_back(configured_sites, monkeypatch):
    monkeypatch.delenv("MARKETPLACE_FRAPPE_LIBAN_API_SECRET")
    with pytest.raises(ValueError, match="Site Frappe invalide"):
        ERPClient("CONGO")
    with pytest.raises(RuntimeError, match="FRAPPE_SITE_NOT_CONFIGURED:LIBAN"):
        ERPClient("LIBAN")


def test_site_url_must_be_https_origin(configured_sites, monkeypatch):
    monkeypatch.setenv("MARKETPLACE_FRAPPE_EUROPE_URL", "https://eu.erp.example.invalid/api")
    with pytest.raises(RuntimeError, match="FRAPPE_SITE_URL_INVALID:EUROPE"):
        ERPClient("EUROPE")


def test_target_country_cannot_select_frappe_site():
    # CPM target_country is intentionally absent from ERPClient's constructor.
    with pytest.raises(TypeError):
        ERPClient(site="EUROPE", target_country="CG")
