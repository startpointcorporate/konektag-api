"""Contact CRUD guards, without a live ERPNext connection."""
import asyncio
import os
import sys
from unittest.mock import AsyncMock

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from erpnext_client import ERPClient


def client():
    obj = ERPClient.__new__(ERPClient)
    return obj


def test_duplicate_email_blocks_creation():
    obj = client()
    obj.search_contacts = AsyncMock(return_value={"records": [
        {"contact": {"name": "CONT-0001"}, "matched_on": ["email"]}
    ], "complete": True})
    obj._lead_collision = AsyncMock(return_value=[])
    obj.request = AsyncMock()
    try:
        asyncio.run(obj.create_contact("Alice", "Test", "alice@example.org"))
        assert False, "Duplicate should block creation"
    except ValueError as error:
        assert "existant" in str(error)
    obj.request.assert_not_called()


def test_existing_lead_blocks_creation():
    obj = client()
    obj.search_contacts = AsyncMock(return_value={"records": [], "complete": True})
    obj._lead_collision = AsyncMock(return_value=[{"name": "CRM-LEAD-0001"}])
    obj.request = AsyncMock()
    try:
        asyncio.run(obj.create_contact("Alice", "Test", "alice@example.org"))
        assert False, "Lead collision should block creation"
    except ValueError as error:
        assert "Lead" in str(error)
    obj.request.assert_not_called()


def test_incomplete_contact_inventory_fails_closed():
    obj = client()
    obj.list = AsyncMock(return_value={"records": [], "complete": False})
    try:
        asyncio.run(obj.search_contacts(email="alice@example.org"))
        assert False, "Incomplete inventory should block matching"
    except RuntimeError as error:
        assert "incomplet" in str(error)


def test_update_requires_fresh_version():
    obj = client()
    obj.request = AsyncMock(return_value={"name": "CONT-0001", "modified": "newer"})
    try:
        asyncio.run(obj.update_contact("CONT-0001", {"first_name": "Alice"}, "older"))
        assert False, "Stale update should be rejected"
    except ValueError as error:
        assert "Conflit" in str(error)
    assert obj.request.await_count == 1
