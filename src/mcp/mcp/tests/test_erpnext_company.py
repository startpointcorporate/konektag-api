import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from erpnext_client import ERPClient


def bare_client():
    return ERPClient.__new__(ERPClient)


@pytest.mark.parametrize("company_name,abbr,country,currency", [
    ("", "KLB", "Lebanon", "USD"),
    ("Konektag Liban", "", "Lebanon", "USD"),
    ("Konektag Liban", "KLB", "", "USD"),
    ("Konektag Liban", "KLB", "Lebanon", "US"),
    ("Konektag Liban", "KLB!", "Lebanon", "USD"),
])
def test_company_input_validation(company_name, abbr, country, currency):
    client = bare_client()
    async def no_list(*args, **kwargs):
        raise AssertionError("invalid input must fail before reading or writing")
    client.list = no_list
    with pytest.raises(ValueError):
        asyncio.run(client.create_company(company_name, abbr, country, currency))


def test_create_company_refuses_incomplete_duplicate_scan():
    client = bare_client()
    async def incomplete(*args, **kwargs):
        return {"records": [], "complete": False, "returned": 1000}
    client.list = incomplete
    with pytest.raises(RuntimeError, match="incomplète"):
        asyncio.run(client.create_company("Konektag Liban", "KLB", "Lebanon", "USD"))


def test_create_company_refuses_duplicate_name_or_abbreviation():
    client = bare_client()
    async def duplicate_name(*args, **kwargs):
        return {"records": [{"name": "Konektag Liban", "company_name": "Konektag Liban", "abbr": "KLB"}],
                "complete": True, "returned": 1}
    client.list = duplicate_name
    with pytest.raises(ValueError, match="Société existante"):
        asyncio.run(client.create_company("Konektag Liban", "KLB2", "Lebanon", "USD"))

    async def duplicate_abbr(*args, **kwargs):
        return {"records": [{"name": "Existing", "company_name": "Existing", "abbr": "KLB"}],
                "complete": True, "returned": 1}
    client.list = duplicate_abbr
    with pytest.raises(ValueError, match="Abréviation déjà utilisée"):
        asyncio.run(client.create_company("Konektag Liban", "KLB", "Lebanon", "USD"))


def test_create_company_requires_known_parent_and_verifies_write():
    client = bare_client()
    async def companies(*args, **kwargs):
        return {"records": [{"name": "Konektag France", "company_name": "Konektag France", "abbr": "KF"}],
                "complete": True, "returned": 1}
    client.list = companies

    with pytest.raises(ValueError, match="parente inconnue"):
        asyncio.run(client.create_company("Konektag Liban", "KLB", "Lebanon", "USD",
                                           parent_company="Unknown"))

    calls = []
    async def request(path, params=None, *, method="GET", payload=None):
        calls.append((path, method, payload))
        return {"name": "Konektag Liban"}
    async def get(doctype, name):
        return {"name": name, "company_name": "Konektag Liban", "abbr": "KLB",
                "country": "Lebanon", "default_currency": "USD", "is_group": 0}
    client.request = request
    client.get = get
    result = asyncio.run(client.create_company("Konektag Liban", "KLB", "Lebanon", "USD",
                                                parent_company="Konektag France"))
    assert result["verified"] is True
    assert calls == [("/api/resource/Company", "POST", {
        "company_name": "Konektag Liban", "abbr": "KLB", "country": "Lebanon",
        "default_currency": "USD", "is_group": 0, "parent_company": "Konektag France",
    })]
