"""Per-request scope — user, tags, request context.

Uses :mod:`contextvars` so each asyncio task (and each thread via the
runtime's own ``copy_context`` semantics) sees its own scope. This is the
Python analogue of the Node SDK's ``AsyncLocalStorage`` store:

    from inariwatch_capture import set_user, run_with_scope

    def handle(req):
        with run_with_scope():   # fresh scope for this request
            set_user({"id": req.user_id})
            ...

Redaction mirrors ``capture/src/scope.ts`` exactly — same header
patterns, same body field set, same truncation limits — so events from
Python and Node services look the same on the wire.
"""

from __future__ import annotations

import contextlib
from contextvars import ContextVar
from typing import Any, Iterator, TypedDict

from .types import RequestContext, User


class _Scope(TypedDict, total=False):
    user: User
    tags: dict[str, str]
    request_context: RequestContext


_scope_var: ContextVar[_Scope] = ContextVar("inariwatch_scope")


# Pattern-based header redaction. Any header whose lowercased name contains
# one of these substrings is replaced with "[REDACTED]". Kept in sync with
# capture/src/scope.ts REDACT_HEADER_PATTERNS.
_REDACT_HEADER_PATTERNS: tuple[str, ...] = (
    "token",
    "key",
    "secret",
    "auth",
    "credential",
    "password",
    "cookie",
    "session",
)

# Body field names that always get replaced with [REDACTED], regardless of
# value type. Must stay in sync with capture/src/scope.ts REDACT_BODY_FIELDS.
_REDACT_BODY_FIELDS: frozenset[str] = frozenset(
    {
        "password",
        "passwd",
        "pass",
        "secret",
        "token",
        "api_key",
        "apiKey",
        "access_token",
        "accessToken",
        "refresh_token",
        "refreshToken",
        "credit_card",
        "creditCard",
        "card_number",
        "cardNumber",
        "cvv",
        "cvc",
        "ssn",
        "social_security",
        "authorization",
    }
)

# Size limits — identical to Node SDK
_MAX_STRING_IN_BODY = 500
_MAX_TOP_LEVEL_STRING = 1024
_MAX_ARRAY_ITEMS = 20


def _should_redact_header(name: str) -> bool:
    lowered = name.lower()
    return any(p in lowered for p in _REDACT_HEADER_PATTERNS)


def _redact_body(body: Any) -> Any:
    if body is None:
        return None
    if isinstance(body, str):
        if len(body) > _MAX_TOP_LEVEL_STRING:
            return body[:_MAX_TOP_LEVEL_STRING] + "...[truncated]"
        return body
    if isinstance(body, list):
        return body[:_MAX_ARRAY_ITEMS]
    if not isinstance(body, dict):
        return body

    safe: dict[str, Any] = {}
    for k, v in body.items():
        if k in _REDACT_BODY_FIELDS or k.lower() in _REDACT_BODY_FIELDS:
            safe[k] = "[REDACTED]"
        elif isinstance(v, str) and len(v) > _MAX_STRING_IN_BODY:
            safe[k] = v[:_MAX_STRING_IN_BODY] + "...[truncated]"
        else:
            safe[k] = v
    return safe


def _get_scope() -> _Scope:
    try:
        return _scope_var.get()
    except LookupError:
        scope: _Scope = {}
        _scope_var.set(scope)
        return scope


# ── Public API ──────────────────────────────────────────────────────────


def set_user(user: dict[str, Any]) -> None:
    """Set user context for the current scope.

    ``email`` is always stripped for privacy — only ``id`` and ``role``
    survive. Mirrors the Node SDK default.
    """
    safe: User = {}
    if "id" in user and user["id"] is not None:
        safe["id"] = str(user["id"])
    if "role" in user and user["role"] is not None:
        safe["role"] = str(user["role"])
    scope = _get_scope()
    scope["user"] = safe


def set_tag(key: str, value: str) -> None:
    scope = _get_scope()
    tags = scope.get("tags")
    if tags is None:
        tags = {}
        scope["tags"] = tags
    tags[str(key)] = str(value)


def set_request_context(
    *,
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    query: dict[str, str] | None = None,
    body: Any = None,
    ip: str | None = None,
) -> None:
    """Attach request metadata to the current scope.

    Sensitive headers (Authorization, Cookie, *-Token, *-Key, *-Secret …)
    and IP-related headers (X-Forwarded-For, X-Real-IP) are redacted.
    Body fields matching ``_REDACT_BODY_FIELDS`` are replaced with
    ``"[REDACTED]"``.
    """
    safe_headers: dict[str, str] | None = None
    if headers:
        safe_headers = {}
        for k, v in headers.items():
            safe_headers[k] = "[REDACTED]" if _should_redact_header(k) else str(v)
        # Also redact IP-bearing headers explicitly — matches Node SDK.
        for ip_header in ("x-forwarded-for", "x-real-ip"):
            if ip_header in safe_headers:
                safe_headers[ip_header] = "[REDACTED]"
            # Header names are case-sensitive in dicts but not in HTTP —
            # scan both cases.
            for k in list(safe_headers):
                if k.lower() == ip_header:
                    safe_headers[k] = "[REDACTED]"

    scope = _get_scope()
    ctx: RequestContext = {
        "method": str(method),
        "url": str(url),
    }
    if safe_headers:
        ctx["headers"] = safe_headers
    if query:
        ctx["query"] = {str(k): str(v) for k, v in query.items()}
    if body is not None:
        ctx["body"] = _redact_body(body)
    # IP omitted by default (GDPR) — only included when caller explicitly
    # sets it, matching Node behaviour.
    if ip is not None:
        ctx["ip"] = str(ip)
    scope["request_context"] = ctx


def get_user() -> User | None:
    return _get_scope().get("user")


def get_tags() -> dict[str, str] | None:
    return _get_scope().get("tags")


def get_request_context() -> RequestContext | None:
    return _get_scope().get("request_context")


@contextlib.contextmanager
def run_with_scope() -> Iterator[None]:
    """Context manager that runs a block inside an isolated scope.

    Use in middleware::

        @app.middleware("http")
        async def iw_middleware(request, call_next):
            with run_with_scope():
                set_request_context(method=request.method, url=str(request.url))
                return await call_next(request)
    """
    token = _scope_var.set({})
    try:
        yield
    finally:
        _scope_var.reset(token)


def clear_scope() -> None:
    """Reset scope to empty. Primarily for tests."""
    _scope_var.set({})


__all__ = [
    "clear_scope",
    "get_request_context",
    "get_tags",
    "get_user",
    "run_with_scope",
    "set_request_context",
    "set_tag",
    "set_user",
]
