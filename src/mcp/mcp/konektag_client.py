"""Shared Konektag business API client.

Uses the same user-scoped API key protocol as ia/tools/konektag-api-tool.sh.
Permissions are enforced by Konektag's API middleware and route handlers.
"""
import os
from urllib.parse import urlsplit
import httpx


class KonektagClient:
    def __init__(self):
        origin = os.getenv("KONEKTAG_URL", "").rstrip("/")
        parts = urlsplit(origin)
        if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password
                or parts.path or parts.query or parts.fragment):
            raise RuntimeError("KONEKTAG_API_URL_INVALID")
        self.origin = origin
        self.key = os.getenv("KONEKTAG_API_KEY", "")
        self.secret = os.getenv("KONEKTAG_API_SECRET", "")
        if not self.key or not self.secret:
            raise RuntimeError("KONEKTAG_API_CREDENTIALS_MISSING")

    async def request(self, method: str, path: str, *, params=None, payload=None):
        if not path.startswith("/api/") or ".." in path or "//" in path or "?" in path or "#" in path:
            raise ValueError("INVALID_KONEKTAG_API_PATH")
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            raise ValueError("INVALID_KONEKTAG_API_METHOD")
        async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=5), follow_redirects=False) as client:
            response = await client.request(
                method, self.origin + path,
                params=params, json=payload,
                headers={
                    "Authorization": f"token {self.key}:{self.secret}",
                    "Accept": "application/json",
                    "Cache-Control": "no-store",
                },
            )
            response.raise_for_status()
            return response.json()
