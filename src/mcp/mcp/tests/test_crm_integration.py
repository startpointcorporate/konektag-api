import asyncio
import importlib
from unittest.mock import AsyncMock

import pytest

from erpnext_client import ERPClient


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("FRAPPE_URL", "https://erp.example.invalid")
    monkeypatch.setenv("FRAPPE_API_KEY", "test")
    monkeypatch.setenv("FRAPPE_API_SECRET", "test")
    client = ERPClient()
    client.list = AsyncMock(return_value={"records": [], "complete": True})
    client.get = AsyncMock(return_value={"name": "CRM-LEAD-1", "company_name": "Acme",
                                         "modified": "v1", "custom_activity_summary": "History"})
    client.request = AsyncMock(return_value={"name": "CRM-LEAD-1"})
    client.lead_commercial_stages = AsyncMock(return_value={"À qualifier", "Qualifié", "Abandonné", "À rechercher", "À contacter"})
    return client


@pytest.mark.parametrize("tool,args", [
    ("crm_create_lead", {"company_name": "Acme", "lead_name": "Acme"}),
    ("crm_update_lead", {"lead_id": "CRM-LEAD-1", "changes": {}, "expected_modified": "v1"}),
])
def test_explicit_confirmation(server_module, monkeypatch, tool, args):
    constructor = AsyncMock()
    monkeypatch.setattr(server_module, "ERPClient", constructor)
    with pytest.raises(PermissionError):
        asyncio.run(getattr(server_module, tool).fn(**args))
    constructor.assert_not_called()


@pytest.mark.parametrize("records,complete", [
    ([{"name": "CRM-LEAD-2", "company_name": " ACME "}], True),
    ([{"name": "CRM-LEAD-2", "lead_name": "acme"}], True),
    ([], False),
])
def test_creation_blocks_duplicates_and_incomplete_search(client, records, complete):
    client.list.return_value = {"records": records, "complete": complete}
    with pytest.raises((ValueError, RuntimeError)):
        asyncio.run(client.create_lead("Acme", "Acme"))
    client.request.assert_not_called()


@pytest.mark.parametrize("extra", [
    {"email_id": "invalid"}, {"custom_axis": "invented"},
    {"custom_commercial_stage": "invented"}, {"custom_next_action_date": "tomorrow"},
])
def test_creation_validation(client, extra):
    with pytest.raises(ValueError):
        asyncio.run(client.create_lead("Acme", "Acme", **extra))
    client.request.assert_not_called()


def test_creation_rereads_real_identifier(client):
    result = asyncio.run(client.create_lead("Acme", "Acme"))
    assert result["lead_id"] == "CRM-LEAD-1" and result["verified"]
    client.get.assert_awaited_once_with("Lead", "CRM-LEAD-1")
    assert client.request.await_args.kwargs["method"] == "POST"


@pytest.mark.parametrize("changes,version", [
    ({"lead_owner": "someone"}, "v1"), ({"custom_next_action": "Call"}, "stale"),
    ({"custom_activity_summary": "Replaced history"}, "v1"),
    ({"custom_commercial_stage": "invented"}, "v1"),
    ({"custom_next_action_date": "tomorrow"}, "v1"),
])
def test_update_guards(client, changes, version):
    with pytest.raises(ValueError):
        asyncio.run(client.update_lead("CRM-LEAD-1", changes, version))
    client.request.assert_not_called()


@pytest.mark.parametrize("verified", [True, False])
def test_update_reread(client, verified):
    client.get.side_effect = [
        {"modified": "v1", "custom_activity_summary": "History"},
        {"modified": "v2", "custom_activity_summary": "History; Call" if verified else "History"},
    ]
    operation = client.update_lead("CRM-LEAD-1", {"custom_activity_summary": "History; Call"}, "v1")
    if verified:
        assert asyncio.run(operation)["verified"]
    else:
        with pytest.raises(RuntimeError):
            asyncio.run(operation)
    assert client.request.await_args.kwargs["method"] == "PUT"


def test_oauth_storage_survives_reload_and_tools_coexist(server_module):
    async def check():
        await server_module._oauth_store.put("integration-check", {"token": "test"})
        reloaded = importlib.reload(server_module)
        assert await reloaded._oauth_store.get("integration-check") == {"token": "test"}
        tools = await reloaded.mcp.get_tools()
        assert {"crm_create_lead", "crm_update_lead", "postiz_list_posts",
                "postiz_platform_analytics", "postiz_post_analytics"} <= set(tools)
    asyncio.run(check())

def test_dynamic_stage_accepts_qualified_and_abandoned(client):
    for stage in ("Qualifié", "Abandonné"):
        client.get.side_effect = [
            {"modified": "v1", "custom_activity_summary": "History"},
            {"modified": "v2", "custom_commercial_stage": stage},
        ]
        result = asyncio.run(client.update_lead("CRM-LEAD-1", {"custom_commercial_stage": stage}, "v1"))
        assert result["verified"]
    assert client.lead_commercial_stages.await_count == 2


def test_effective_stage_metadata(client, monkeypatch):
    import httpx
    original = httpx.AsyncClient
    def respond(request):
        assert request.url.path == "/api/method/frappe.desk.form.load.getdoctype"
        assert request.url.params["doctype"] == "Lead"
        return httpx.Response(200, json={"docs": [
            {"doctype": "Custom Field", "dt": "Lead", "fieldname": "custom_commercial_stage",
             "options": "À rechercher\nÀ contacter\nQualifié\nAbandonné"},
        ]})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(respond), **kw))
    assert asyncio.run(ERPClient.lead_commercial_stages(client)) == {
        "À rechercher", "À contacter", "Qualifié", "Abandonné"
    }
