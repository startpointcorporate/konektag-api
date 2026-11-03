import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from erpnext_client import ERPClient


def bare_client():
    return ERPClient.__new__(ERPClient)


def test_create_item_adds_company_default_and_rejects_duplicate():
    client = bare_client()
    async def get_company(doctype, name):
        return {"name": name}
    async def items(*args, **kwargs):
        return {"records": [], "complete": True, "returned": 0}
    calls = []
    async def request(path, params=None, *, method="GET", payload=None):
        calls.append((path, method, payload))
        return {"name": "BOOST-001"}
    async def read_item(company, item_code):
        return {"item_code": item_code, "item_name": "Boost", "item_group": "Services",
                "stock_uom": "Unit", "company_defaults": {"company": company}}
    client.get = get_company
    client.list = items
    client.request = request
    client.get_item = read_item
    result = asyncio.run(client.create_item("Konektag France", "BOOST-001", "Boost",
                                             "Services", "Unit", False))
    assert result["verified"] is True
    assert calls[0] == ("/api/resource/Item", "POST", {
        "item_code": "BOOST-001", "item_name": "Boost", "item_group": "Services",
        "stock_uom": "Unit", "is_stock_item": 0, "is_sales_item": 1,
        "is_purchase_item": 1, "item_defaults": [{"company": "Konektag France"}],
    })

    async def duplicate(*args, **kwargs):
        return {"records": [{"name": "BOOST-001", "item_code": "BOOST-001"}],
                "complete": True, "returned": 1}
    client.list = duplicate
    with pytest.raises(ValueError, match="déjà utilisé"):
        asyncio.run(client.create_item("Konektag France", "BOOST-001", "Boost",
                                       "Services", "Unit", False))


def test_create_item_requires_complete_duplicate_scan():
    client = bare_client()
    client.get = lambda *args: asyncio.sleep(0, result={"name": args[-1]})
    client.list = lambda *args, **kwargs: asyncio.sleep(0, result={
        "records": [], "complete": False, "returned": 1000,
    })
    with pytest.raises(RuntimeError, match="incomplète"):
        asyncio.run(client.create_item("Konektag France", "BOOST-001", "Boost",
                                       "Services", "Unit", False))


def test_get_item_requires_company_specific_default():
    client = bare_client()
    client.get = lambda *args: asyncio.sleep(0, result={"name": args[-1]})
    client.request = lambda *args, **kwargs: asyncio.sleep(0, result={
        "name": "BOOST-001", "item_code": "BOOST-001", "item_name": "Boost",
        "item_defaults": [{"company": "Konektag Congo"}],
    })
    with pytest.raises(ValueError, match="pas configuré"):
        asyncio.run(client.get_item("Konektag France", "BOOST-001"))


def test_update_item_preserves_other_company_defaults_and_checks_modified():
    client = bare_client()
    current = {
        "name": "BOOST-001", "item_code": "BOOST-001", "item_name": "Boost",
        "modified": "2026-10-16 12:00:00",
        "item_defaults": [
            {"name": "row-fr", "company": "Konektag France", "income_account": "Sales - KF"},
            {"name": "row-cg", "company": "Konektag Congo", "income_account": "Sales - KC"},
        ],
    }
    calls = []
    async def request(path, params=None, *, method="GET", payload=None):
        calls.append((path, method, payload))
        return current if method == "GET" else {"name": "BOOST-001"}
    async def read_item(company, item_code):
        return {
            "item_code": item_code, "item_name": "Boost updated",
            "modified": "2026-10-16 12:01:00",
            "company_defaults": {"company": company, "income_account": "Sales - KF",
                                 "default_price_list": "Standard Selling"},
        }
    client.request = request
    client.get_item = read_item
    result = asyncio.run(client.update_item(
        "Konektag France", "BOOST-001",
        {"item_name": "Boost updated"},
        {"default_price_list": "Standard Selling"},
        "2026-10-16 12:00:00",
    ))
    assert result["verified"] is True
    payload = calls[1][2]
    assert payload["item_name"] == "Boost updated"
    assert payload["item_defaults"] == [
        {"name": "row-fr", "company": "Konektag France", "income_account": "Sales - KF",
         "default_price_list": "Standard Selling"},
        {"name": "row-cg", "company": "Konektag Congo", "income_account": "Sales - KC"},
    ]

    with pytest.raises(ValueError, match="Champ Item"):
        asyncio.run(client.update_item(
            "Konektag France", "BOOST-001", {"stock_uom": "Carton"}, {},
            "2026-10-16 12:00:00",
        ))
