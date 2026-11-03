"""Focused tests for the Unipile transport without initializing live OAuth wiring."""
import ast
from pathlib import Path
import re
import unittest
from unittest.mock import AsyncMock, patch

import httpx


def load_functions():
    """Compile the real function bodies while excluding the OAuth startup side effects."""
    source = Path(__file__).resolve().parents[1].joinpath("server.py").read_text()
    module = ast.parse(source)
    names = {"_post", "_whatsapp_account", "unipile_send_message"}
    nodes = []
    for node in module.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            nodes.append(node)
    namespace = {
        "re": re,
        "httpx": httpx,
        "BASE": "https://unipile.example:20135",
        "KEY": "test-key",
        "WHATSAPP_ACCOUNT": "whatsapp-account",
        "_validate": lambda: None,
        "_confirm": lambda confirmed: (
            None if confirmed is True else (_ for _ in ()).throw(PermissionError())
        ),
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<server.py>", "exec"), namespace)
    return namespace


class UnipileTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_post_uses_multipart_for_text(self):
        ns = load_functions()
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(201, json={"object": "Message"})

        original = httpx.AsyncClient
        transport = httpx.MockTransport(handle)
        with patch.object(httpx, "AsyncClient", side_effect=lambda **kw: original(transport=transport, **kw)):
            result = await ns["_post"]("chats/test/messages", form_data={"text": "hello"})
        self.assertEqual(result["object"], "Message")
        self.assertEqual(len(requests), 1)
        self.assertTrue(requests[0].headers["content-type"].startswith("multipart/form-data;"))
        self.assertIn(b'name="text"', requests[0].content)
        self.assertIn(b"hello", requests[0].content)
        self.assertNotIn(b'name="account_id"', requests[0].content)

    async def test_send_checks_chat_account_and_provider(self):
        ns = load_functions()
        ns["_get"] = AsyncMock(return_value={
            "account_id": "whatsapp-account", "account_type": "WHATSAPP"
        })
        ns["_post"] = AsyncMock(return_value={"object": "Message"})
        await ns["unipile_send_message"]("validChat123", "hello", confirmed=True)
        ns["_post"].assert_awaited_once_with(
            "chats/validChat123/messages", form_data={"text": "hello"}
        )

    async def test_foreign_chat_fails_without_post(self):
        ns = load_functions()
        ns["_get"] = AsyncMock(return_value={
            "account_id": "another-account", "account_type": "WHATSAPP"
        })
        ns["_post"] = AsyncMock()
        with self.assertRaises(PermissionError):
            await ns["unipile_send_message"]("validChat123", "hello", confirmed=True)
        ns["_post"].assert_not_awaited()

    async def test_non_whatsapp_chat_fails_without_post(self):
        ns = load_functions()
        ns["_get"] = AsyncMock(return_value={
            "account_id": "whatsapp-account", "account_type": "LINKEDIN"
        })
        ns["_post"] = AsyncMock()
        with self.assertRaises(PermissionError):
            await ns["unipile_send_message"]("validChat123", "hello", confirmed=True)
        ns["_post"].assert_not_awaited()

    async def test_unapproved_or_wrong_account_fails_closed(self):
        ns = load_functions()
        ns["_get"] = AsyncMock()
        ns["_post"] = AsyncMock()
        with self.assertRaises(PermissionError):
            await ns["unipile_send_message"]("validChat123", "hello")
        with self.assertRaises(PermissionError):
            await ns["unipile_send_message"](
                "validChat123", "hello", account_id="other-account", confirmed=True
            )
        ns["_get"].assert_not_awaited()
        ns["_post"].assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
