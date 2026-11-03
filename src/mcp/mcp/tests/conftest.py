import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def server_module(monkeypatch, tmp_path):
    import fastmcp
    import key_value.aio.stores.disk as disk

    monkeypatch.setattr(fastmcp.settings, "home", tmp_path)
    original = disk.DiskStore

    def local_store(*, directory):
        assert directory == "/app/data/oauth"
        return original(directory=tmp_path / "oauth")

    monkeypatch.setattr(disk, "DiskStore", local_store)
    for key in ["FRAPPE_URL", "FRAPPE_API_KEY", "FRAPPE_API_SECRET", "MCP_PUBLIC_URL",
                "OAUTH_AUTHORIZE_URL", "OAUTH_TOKEN_URL", "OAUTH_CLIENT_ID",
                "OAUTH_CLIENT_SECRET", "OAUTH_JWKS_URI", "OAUTH_ISSUER", "OAUTH_AUDIENCE"]:
        monkeypatch.setenv(key, "https://example.invalid" if "URL" in key or
                           key in ["OAUTH_JWKS_URI", "OAUTH_ISSUER"] else "test")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    yield server
    sys.modules.pop("server", None)
