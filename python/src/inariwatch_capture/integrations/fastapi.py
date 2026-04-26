"""ASGI middleware for FastAPI / Starlette.

Wraps the request lifecycle in :func:`run_with_scope` so every request
sees its own ``set_user`` / ``set_tag`` / ``set_request_context`` state.
Unhandled exceptions propagate to the ASGI app's own error handling,
but we capture them on the way past so the user doesn't need
per-endpoint ``try / except``.

Usage::

    from fastapi import FastAPI
    from inariwatch_capture import init
    from inariwatch_capture.integrations.fastapi import InariWatchMiddleware

    init(dsn="...")
    app = FastAPI()
    app.add_middleware(InariWatchMiddleware)

Pure ASGI — works with any Starlette-based framework (FastAPI,
Starlette, Litestar, BlackSheep over a Starlette adapter, etc.). We do
**not** depend on ``fastapi`` or ``starlette`` at import time so users
who only use the middleware with a hand-rolled ASGI app don't pay the
import cost.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable
from urllib.parse import urlunsplit

from ..client import capture_exception
from ..scope import run_with_scope, set_request_context

# ASGI type aliases — avoid importing ``starlette.types`` so the module
# can be imported in environments that only have ``asgiref``.
Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def _build_url(scope: Scope) -> str:
    scheme = scope.get("scheme", "http")
    server = scope.get("server") or ("", 0)
    host = scope.get("headers")
    host_value = ""
    if host:
        for k, v in host:
            if k == b"host":
                try:
                    host_value = v.decode("latin-1")
                except Exception:
                    host_value = ""
                break
    if not host_value:
        hostname, port = server
        if hostname:
            host_value = f"{hostname}:{port}" if port else str(hostname)
    path = scope.get("path", "")
    query = scope.get("query_string") or b""
    query_str = query.decode("latin-1") if isinstance(query, (bytes, bytearray)) else str(query)
    return urlunsplit((scheme, host_value, path, query_str, ""))


def _extract_headers(scope: Scope) -> dict[str, str]:
    headers: dict[str, str] = {}
    for k, v in scope.get("headers") or []:
        try:
            headers[k.decode("latin-1")] = v.decode("latin-1")
        except Exception:
            continue
    return headers


class InariWatchMiddleware:
    """ASGI middleware that enriches errors with request context."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        with run_with_scope():
            try:
                method = scope.get("method", "GET") if scope["type"] == "http" else "WS"
                set_request_context(
                    method=method,
                    url=_build_url(scope),
                    headers=_extract_headers(scope) or None,
                )
                await self.app(scope, receive, send)
            except Exception as err:
                capture_exception(
                    err,
                    context={
                        "runtime": "python",
                        "routeType": scope.get("type"),
                    },
                )
                raise


__all__ = ["InariWatchMiddleware"]
