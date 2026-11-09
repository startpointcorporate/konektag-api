"""Fail-closed CPM API client for the Konektag MCP.

The Konektag application remains the authorization and pricing source of truth.
This client deliberately does not write directly to PostgreSQL or ERPNext.
"""
import re
from konektag_client import KonektagClient

_ALLOWED = {"facebook", "instagram", "tiktok"}
_COUNTRY = re.compile(r"^[A-Z]{2}$")


def _validate(channel=None, country=None):
    if channel is not None and channel not in _ALLOWED:
        raise ValueError("INVALID_CHANNEL")
    if country is not None and not _COUNTRY.fullmatch(country):
        raise ValueError("INVALID_TARGET_COUNTRY")


class CPMClient:
    def __init__(self):
        self.api = KonektagClient()

    async def list(self, channel=None, country=None, company=None):
        _validate(channel, country)
        result = await self.api.request("GET", "/api/admin/boost-pricing")
        mappings = result.get("mappings")
        if not isinstance(mappings, list):
            raise RuntimeError("INVALID_CPM_API_RESPONSE")
        return {"mappings": [
            m for m in mappings
            if (channel is None or m.get("channel") == channel)
            and (country is None or m.get("target_country") == country)
            and (company is None or m.get("billing_company") == company)
        ], "price_verification": "not_available_in_mapping_response"}

    async def get(self, channel, country, company):
        _validate(channel, country)
        items = (await self.list(channel, country, company))["mappings"]
        if len(items) != 1:
            raise ValueError("CPM_MAPPING_NOT_UNIQUE_OR_MISSING")
        return items[0]

    async def prices(self, channel: str, country: str, company: str | None = None):
        """Read actual verified CPM amounts via Konektag's production resolver."""
        _validate(channel, country)
        if channel is None or country is None:
            raise ValueError("CHANNEL_AND_COUNTRY_REQUIRED")
        params = {"channel": channel, "target_country": country}
        if company:
            params["billing_company"] = company
        result = await self.api.request("GET", "/api/admin/boost-pricing/prices", params=params)
        if result.get("complete") is not True or not isinstance(result.get("prices"), list):
            raise RuntimeError("INVALID_CPM_PRICES_RESPONSE")
        return result

    async def update(self, channel: str, country: str, company: str,
                     expected_cpm: str, new_cpm: str, confirm: bool = False):
        """Change one real ERPNext CPM via Konektag's authorized backend."""
        _validate(channel, country)
        if not channel or not country or not company:
            raise ValueError("CPM_SCOPE_REQUIRED")
        if confirm is not True:
            raise PermissionError("CPM_UPDATE_REQUIRES_CONFIRMATION")
        if not isinstance(expected_cpm, str) or not isinstance(new_cpm, str):
            raise ValueError("CPM_DECIMAL_STRINGS_REQUIRED")
        return await self.api.request("POST", "/api/admin/boost-pricing/update",
            payload={"channel": channel, "target_country": country,
                     "billing_company": company, "expected_cpm": expected_cpm,
                     "new_cpm": new_cpm, "confirm": True})

    async def audit(self):
        data = await self.list()
        rows = data["mappings"]
        seen = set()
        duplicates = []
        for row in rows:
            key = (row.get("channel"), row.get("target_country"), row.get("billing_company"))
            if key in seen:
                duplicates.append(key)
            seen.add(key)
        return {"mapping_count": len(rows), "duplicate_keys": duplicates,
                "erpnext_prices_verified": False,
                "note": "Price audit requires a dedicated server-side verified price endpoint."}
