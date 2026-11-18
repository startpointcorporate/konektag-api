"""Unit tests for read-only Digital Audit MCP client. Run: python -m unittest discover -s ia/mcp/tests -p 'test_digital_audit.py'."""
import asyncio
import os
import sys
import unittest
import httpx
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from erpnext_client import ERPClient, FIELDS


class DigitalAuditTests(unittest.TestCase):
    def setUp(self):
        env = {"MARKETPLACE_FRAPPE_EUROPE_URL": "https://example.invalid", "MARKETPLACE_FRAPPE_EUROPE_API_KEY": "test", "MARKETPLACE_FRAPPE_EUROPE_API_SECRET": "test"}
        with patch.dict(os.environ, env):
            self.client = ERPClient("EUROPE")

    def test_fields_include_audit(self):
        self.assertIn("Digital Audit", FIELDS)
        self.assertIn("requested_at", FIELDS["Digital Audit"])

    def test_list_filters_and_completeness(self):
        self.client.list = AsyncMock(return_value={"records": [], "complete": True, "returned": 0})
        result = asyncio.run(self.client.digital_audit_list(status="NEW"))
        self.assertTrue(result["complete"])
        self.client.list.assert_awaited_once_with("Digital Audit", max_records=500, filters=[
            ["Digital Audit", "status", "=", "NEW"],
            ["Digital Audit", "source", "=", "KONEKTAG Website"],
        ])

    def test_summary_partial(self):
        self.client.digital_audit_list = AsyncMock(return_value={"records": [{"status": "NEW"}], "returned": 1, "complete": False})
        result = asyncio.run(self.client.digital_audit_audit())
        self.assertEqual(result["by_status"], {"NEW": 1})
        self.assertFalse(result["complete"])

    def test_get_rejects_invalid_id(self):
        with self.assertRaises(ValueError):
            asyncio.run(self.client.digital_audit_get("../../bad"))

    def test_absent_doctype_has_explicit_status(self):
        request = httpx.Request("GET", "https://example.invalid/api/resource/Digital%20Audit")
        response = httpx.Response(404, request=request,
                                  json={"exc_type": "DoesNotExistError", "message": "DocType Digital Audit"})
        self.client.list = AsyncMock(side_effect=httpx.HTTPStatusError("not found", request=request,
                                                                      response=response))
        with self.assertRaisesRegex(RuntimeError, "DIGITAL_AUDIT_DOCTYPE_ABSENT:EUROPE"):
            asyncio.run(self.client.digital_audit_list())

    def test_invalid_route_has_explicit_status(self):
        request = httpx.Request("GET", "https://example.invalid/api/resource/Digital%20Audit")
        response = httpx.Response(404, request=request, text="proxy route not found")
        self.client.list = AsyncMock(side_effect=httpx.HTTPStatusError("not found", request=request,
                                                                      response=response))
        with self.assertRaisesRegex(RuntimeError, "DIGITAL_AUDIT_ROUTE_INVALID:EUROPE"):
            asyncio.run(self.client.digital_audit_list())


if __name__ == "__main__":
    unittest.main()
