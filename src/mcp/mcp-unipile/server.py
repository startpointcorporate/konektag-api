"""Konektag Unipile MCP with Keycloak OAuth authentication."""
import os
import re
import base64
import hashlib
from cryptography.fernet import Fernet
from key_value.aio.stores.disk import DiskStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper
from fastmcp.server.auth import OAuthProxy
from fastmcp.server.auth.providers.jwt import JWTVerifier
from typing import Any
import httpx
from fastmcp import FastMCP

OAUTH_REQUIRED = [
    "OAUTH_AUTHORIZE_URL", "OAUTH_TOKEN_URL", "OAUTH_CLIENT_ID",
    "OAUTH_CLIENT_SECRET", "OAUTH_JWKS_URI", "OAUTH_ISSUER", "OAUTH_AUDIENCE", "MCP_PUBLIC_URL",
]
missing = [key for key in OAUTH_REQUIRED if not os.getenv(key)]
if missing:
    raise RuntimeError("Missing OAuth configuration: " + ", ".join(missing))
secret = os.environ["OAUTH_CLIENT_SECRET"].encode()
store = FernetEncryptionWrapper(
    key_value=DiskStore(directory=os.getenv("OAUTH_STORE_DIR", "/app/data/oauth")),
    fernet=Fernet(base64.urlsafe_b64encode(
        hashlib.sha256(b"konektag-unipile-store-v1:" + secret).digest()
    )),
)
auth = OAuthProxy(
    jwt_signing_key=hashlib.sha256(b"konektag-unipile-jwt-v1:" + secret).hexdigest(),
    client_storage=store,
    upstream_authorization_endpoint=os.environ["OAUTH_AUTHORIZE_URL"],
    upstream_token_endpoint=os.environ["OAUTH_TOKEN_URL"],
    upstream_client_id=os.environ["OAUTH_CLIENT_ID"],
    upstream_client_secret=os.environ["OAUTH_CLIENT_SECRET"],
    token_verifier=JWTVerifier(
        jwks_uri=os.environ["OAUTH_JWKS_URI"],
        issuer=os.environ["OAUTH_ISSUER"],
        audience=os.environ["OAUTH_AUDIENCE"],
    ),
    base_url=os.environ["MCP_PUBLIC_URL"].rstrip("/"),
    extra_authorize_params=(
        {"audience": os.environ["OAUTH_AUDIENCE"]}
        if os.environ.get("OAUTH_SEND_AUDIENCE", "false").lower() == "true"
        else None
    ),
)
mcp = FastMCP("Konektag Unipile", auth=auth)

# RFC 8414 path-aware discovery. The installed SDK publishes the unprefixed
# authorization metadata route; reuse that exact handler for a path-based issuer.
from urllib.parse import urlsplit
_public_path = urlsplit(os.environ["MCP_PUBLIC_URL"]).path.rstrip("/")
if _public_path:
    for _route in auth.get_routes("/mcp"):
        if _route.path == "/.well-known/oauth-authorization-server":
            mcp.custom_route("/.well-known/oauth-authorization-server" + _public_path,
                             methods=["GET", "OPTIONS"])(_route.endpoint)
BASE = os.environ.get("UNIPILE_BASE_URL", "").rstrip("/")
KEY = os.environ.get("UNIPILE_API_KEY", "")
DEFAULT_ACCOUNT = os.environ.get("UNIPILE_LINKEDIN_ACCOUNT_ID", "")
WHATSAPP_ACCOUNT = os.environ.get("UNIPILE_WHATSAPP_ACCOUNT_ID", "")


def _validate() -> None:
    if not BASE.startswith("https://") or not KEY:
        raise ValueError("UNIPILE_BASE_URL (HTTPS) and UNIPILE_API_KEY must be configured")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?", BASE):
        raise ValueError("Invalid Unipile base URL")


async def _get(path: str, params: dict[str, Any] | None = None) -> dict:
    _validate()
    async with httpx.AsyncClient(timeout=25, follow_redirects=False) as client:
        response = await client.get(
            f"{BASE}/api/v1/{path}",
            headers={"X-API-KEY": KEY, "Accept": "application/json"},
            params=params,
        )
        response.raise_for_status()
        return response.json()


@mcp.tool()
async def unipile_accounts() -> dict:
    """List connected Unipile accounts and statuses (read only)."""
    return await _get("accounts")


@mcp.tool()
async def unipile_linkedin_search(keywords: str, limit: int = 10) -> dict:
    """Search LinkedIn people, including profiles outside direct connections; read-only."""
    if not keywords.strip() or len(keywords) > 120:
        raise ValueError("keywords required (maximum 120 characters)")
    if not 1 <= limit <= 25:
        raise ValueError("limit must be between 1 and 25")
    _validate()
    if not DEFAULT_ACCOUNT:
        raise ValueError("UNIPILE_LINKEDIN_ACCOUNT_ID required")
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        response = await client.post(
            f"{BASE}/api/v1/linkedin/search",
            headers={"X-API-KEY": KEY, "Accept": "application/json"},
            params={"account_id": DEFAULT_ACCOUNT},
            json={"api": "classic", "category": "people", "keywords": keywords},
        )
        response.raise_for_status()
        result = response.json()
        if isinstance(result.get("items"), list):
            result["items"] = result["items"][:limit]
        return result


@mcp.tool()
async def unipile_chats(limit: int = 10, account_id: str = "", cursor: str = "") -> dict:
    """List chats; may include personal chats. Does not send or sync anything."""
    if not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    account = account_id or WHATSAPP_ACCOUNT or DEFAULT_ACCOUNT
    if not account:
        raise ValueError("account_id required")
    params = {"account_id": account, "limit": limit}
    if cursor:
        params["cursor"] = cursor
    return await _get("chats", params)


@mcp.tool()
async def unipile_chat_messages(chat_id: str, limit: int = 10, cursor: str = "") -> dict:
    """Read messages of a specified chat. No messages are sent."""
    if not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", chat_id):
        raise ValueError("Invalid chat id")
    params = {"limit": limit}
    if cursor:
        params["cursor"] = cursor
    return await _get(f"chats/{chat_id}/messages", params)


async def _post(path: str, *, json_data: dict | None = None, form_data: dict | None = None) -> dict:
    _validate()
    if (json_data is None) == (form_data is None):
        raise ValueError("Exactly one payload type is required")
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        response = await client.post(
            f"{BASE}/api/v1/{path}",
            headers={"X-API-KEY": KEY, "Accept": "application/json"},
            json=json_data,
            files=(
                {field: (None, str(value)) for field, value in form_data.items()}
                if form_data is not None else None
            ),
        )
        response.raise_for_status()
        return response.json()


def _confirm(confirmed: bool) -> None:
    if confirmed is not True:
        raise PermissionError("Explicit approval required: confirmed=True")


def _account(account_id: str) -> str:
    account = account_id or DEFAULT_ACCOUNT
    if not account or not re.fullmatch(r"[A-Za-z0-9_-]+", account):
        raise ValueError("Valid account ID required")
    if DEFAULT_ACCOUNT and account != DEFAULT_ACCOUNT:
        raise PermissionError("Account is outside the configured scope")
    return account


def _whatsapp_account(account_id: str) -> str:
    """Restrict WhatsApp writes to the explicitly configured WhatsApp account."""
    if not WHATSAPP_ACCOUNT or not re.fullmatch(r"[A-Za-z0-9_-]+", WHATSAPP_ACCOUNT):
        raise ValueError("UNIPILE_WHATSAPP_ACCOUNT_ID must be configured")
    account = account_id or WHATSAPP_ACCOUNT
    if account != WHATSAPP_ACCOUNT:
        raise PermissionError("WhatsApp account is outside the configured scope")
    return account


@mcp.tool()
async def unipile_user_profile(identifier: str, account_id: str = "") -> dict:
    """Read a public/accessible profile to resolve its provider_id."""
    from urllib.parse import quote
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,120}", identifier):
        raise ValueError("Invalid user identifier")
    return await _get(f"users/{quote(identifier, safe='')}", {"account_id": _account(account_id)})


@mcp.tool()
async def unipile_invite_user(provider_id: str, message: str = "",
                              account_id: str = "", confirmed: bool = False) -> dict:
    """Send one LinkedIn connection invitation only after explicit approval."""
    _confirm(confirmed)
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,150}", provider_id):
        raise ValueError("Valid provider_id required")
    if len(message) > 300:
        raise ValueError("Invitation message exceeds 300 characters")
    return await _post("users/invite", json_data={
        "provider_id": provider_id,
        "account_id": _account(account_id),
        **({"message": message} if message else {}),
    })


@mcp.tool()
async def unipile_send_message(chat_id: str, text: str,
                                account_id: str = "", confirmed: bool = False) -> dict:
    """Send one message to an existing chat after explicit approval."""
    _confirm(confirmed)
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,150}", chat_id):
        raise ValueError("Invalid chat identifier")
    if not text.strip() or len(text) > 5000:
        raise ValueError("Message must contain 1–5000 characters")
    account = _whatsapp_account(account_id)
    chat = await _get(f"chats/{chat_id}")
    if chat.get("account_id") != account or chat.get("account_type") != "WHATSAPP":
        raise PermissionError("Chat does not belong to the configured WhatsApp account")
    # Existing chats are identified by chat_id; do not send account_id in the payload.
    return await _post(f"chats/{chat_id}/messages", form_data={"text": text})


@mcp.tool()
async def unipile_start_chat(provider_id: str, text: str,
                              account_id: str = "", confirmed: bool = False) -> dict:
    """Start one new chat only when provider permissions allow it and after approval."""
    _confirm(confirmed)
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,150}", provider_id):
        raise ValueError("Valid provider_id required")
    if not text.strip() or len(text) > 5000:
        raise ValueError("Message must contain 1–5000 characters")
    return await _post("chats", form_data={
        "account_id": _whatsapp_account(account_id), "text": text,
        "attendees_ids": provider_id,
    })


if __name__ == "__main__":
    # Expose behind existing Konektag OAuth gateway; do not publish port directly.
    mcp.run(transport="http", host=os.getenv("UNIPILE_MCP_HOST", "127.0.0.1"), port=int(os.getenv("UNIPILE_MCP_PORT", "8011")))
