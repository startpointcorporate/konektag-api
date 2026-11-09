import asyncio
from cpm_client import CPMClient


def test_resolved_prices_call_uses_backend(monkeypatch):
    client = CPMClient.__new__(CPMClient)
    calls = []
    class API:
        async def request(self, method, path, *, params=None, **kwargs):
            calls.append((method, path, params))
            return {"complete": True, "prices": [{"currency": "EUR", "cpm": "8.40", "price_status": "VERIFIED"}]}
    client.api = API()
    result = asyncio.run(client.prices("facebook", "FR", "Konektag France"))
    assert result["prices"][0]["cpm"] == "8.40"
    assert calls == [("GET", "/api/admin/boost-pricing/prices",
                      {"channel": "facebook", "target_country": "FR", "billing_company": "Konektag France"})]


def test_resolved_prices_rejects_bad_country():
    client = CPMClient.__new__(CPMClient)
    try:
        asyncio.run(client.prices("facebook", "../", None))
    except ValueError as e:
        assert str(e) == "INVALID_TARGET_COUNTRY"
    else:
        raise AssertionError("expected validation error")
