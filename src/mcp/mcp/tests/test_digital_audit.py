"""Unit tests for read-only Digital Audit MCP client. Run: python -m unittest discover -s ia/mcp/tests -p 'test_digital_audit.py'."""
import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from erpnext_client import ERPClient, FIELDS


class DigitalAuditTests(unittest.TestCase):
    def setUp(self):
        env = {"FRAPPE_URL": "https://example.invalid", "FRAPPE_API_KEY": "test", "FRAPPE_API_SECRET": "test"}
        with patch.dict(os.environ, env):
            self.client = ERPClient()

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


if __name__ == "__main__":
    unittest.main()
