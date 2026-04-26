"""Breadcrumb ring buffer + auto-intercept for ``logging`` / ``requests`` / ``httpx``.

Mirrors ``capture/src/breadcrumbs.ts``:

- Ring buffer of the last 30 actions, FIFO.
- Secret patterns scrubbed before storage (bearer tokens, JWTs, API keys,
  connection strings, query-string secrets).
- URL query parameters containing ``token``/``key``/``secret``/... are
  replaced with ``[REDACTED]`` before the URL is stored.

Instead of monkey-patching ``console.log`` (which has no Python analogue
with the same broadcast-everywhere semantic), we install a
``logging.Handler`` on the root logger. For HTTP calls we optionally
monkey-patch ``requests.Session.request`` and ``httpx.Client.send`` when
those libraries are importable.
"""

from __future__ import annotations

import logging
import re
import threading
from collections import deque
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .types import Breadcrumb, BreadcrumbCategory, BreadcrumbLevel

_MAX_BREADCRUMBS = 30

# Ring buffer is process-wide but cheap. Protected by a mutex because
# logging handlers can fire on any thread.
_lock = threading.Lock()
_buffer: deque[Breadcrumb] = deque(maxlen=_MAX_BREADCRUMBS)

_initialized = False

# Secret patterns — mirror capture/src/breadcrumbs.ts SECRET_PATTERNS.
_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/]+=*"),
    re.compile(r"[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}"),
    re.compile(
        r"(?:sk|pk|api|key|token|secret|password|passwd)[_-]?[:\s=]+\S{8,}",
        re.IGNORECASE,
    ),
    re.compile(r"://[^:/]+:[^@]+@"),
    re.compile(
        r"[?&](api_key|token|secret|key|password|auth|credential)=[^&\s]+",
        re.IGNORECASE,
    ),
)

_SENSITIVE_QUERY_PARAMS: frozenset[str] = frozenset(
    {
        "token",
        "key",
        "secret",
        "password",
        "auth",
        "credential",
        "api_key",
        "apiKey",
        "access_token",
    }
)


def _scrub_secrets(text: str) -> str:
    out = text
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    return out


def scrub_url(url: str) -> str:
    """Remove sensitive query parameters from ``url``.

    Accepts absolute URLs and path-relative URLs alike. On any parse
    error, falls back to ``_scrub_secrets`` so we never return an
    unredacted URL.
    """
    try:
        parts = urlsplit(url)
        if not parts.query:
            # No query string — still scrub in case someone stuffed a
            # secret into the path. Fall through to text-level scrub.
            return _scrub_secrets(url)
        pairs = parse_qsl(parts.query, keep_blank_values=True)
        clean_pairs = [
            (k, "[REDACTED]" if k in _SENSITIVE_QUERY_PARAMS else v) for k, v in pairs
        ]
        new_query = urlencode(clean_pairs)
        cleaned = urlunsplit(
            (parts.scheme, parts.netloc, parts.path, new_query, parts.fragment)
        )
        # Preserve relative URLs without the leading "//"
        if url.startswith("/") and not url.startswith("//"):
            return cleaned.lstrip("/") if cleaned.startswith("//") else cleaned
        return cleaned
    except Exception:
        return _scrub_secrets(url)


def add_breadcrumb(crumb: dict[str, Any]) -> None:
    """Append a breadcrumb to the ring buffer.

    ``crumb`` must include ``message``. Optional keys: ``category``,
    ``level``, ``data``. Secrets are scrubbed from ``message``; ``data``
    is stored as-is (caller's responsibility).
    """
    if "message" not in crumb:
        raise ValueError("breadcrumb requires 'message'")

    category: BreadcrumbCategory = crumb.get("category", "custom")
    level: BreadcrumbLevel = crumb.get("level", "info")
    raw_message = str(crumb["message"])
    # Match Node's 200-char cap + scrub order: slice first, then scrub.
    message = _scrub_secrets(raw_message[:200])

    entry: Breadcrumb = {
        "timestamp": _now_iso(),
        "category": category,
        "level": level,
        "message": message,
    }
    if "data" in crumb and crumb["data"] is not None:
        entry["data"] = crumb["data"]

    with _lock:
        _buffer.append(entry)


def get_breadcrumbs() -> list[Breadcrumb]:
    with _lock:
        return list(_buffer)


def clear_breadcrumbs() -> None:
    """For tests."""
    with _lock:
        _buffer.clear()


def _now_iso() -> str:
    # Matches JS ``new Date().toISOString()`` — UTC, millisecond precision,
    # trailing ``Z``.
    now = datetime.now(timezone.utc)
    # strftime is locale-sensitive for %Z, so we build manually.
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


# ── Auto-intercept ───────────────────────────────────────────────────────


class _BreadcrumbLoggingHandler(logging.Handler):
    """Turn every ``logging`` record into a breadcrumb.

    We leave the original handlers in place so logs still go wherever the
    app sends them; we just piggyback to record the trail.
    """

    _LEVEL_MAP: dict[int, BreadcrumbLevel] = {
        logging.DEBUG: "debug",
        logging.INFO: "info",
        logging.WARNING: "warning",
        logging.ERROR: "error",
        logging.CRITICAL: "error",
    }

    def emit(self, record: logging.LogRecord) -> None:  # pragma: no cover - simple glue
        try:
            message = self.format(record)
        except Exception:
            message = record.getMessage()
        level = self._LEVEL_MAP.get(record.levelno, "info")
        add_breadcrumb(
            {
                "category": "log",
                "level": level,
                "message": message,
                "data": {"logger": record.name},
            }
        )


def _try_patch_requests() -> None:
    try:
        import requests  # type: ignore[import-not-found]
    except ImportError:
        return

    session_cls = requests.Session
    # Idempotent — guard against double-wrap.
    if getattr(session_cls.request, "_inariwatch_wrapped", False):
        return

    orig_request = session_cls.request

    def wrapped(self, method, url, **kwargs):  # type: ignore[no-untyped-def]
        safe_url = scrub_url(str(url))
        add_breadcrumb(
            {"category": "http", "level": "info", "message": f"{method} {safe_url}"}
        )
        try:
            resp = orig_request(self, method, url, **kwargs)
        except Exception:
            add_breadcrumb(
                {
                    "category": "http",
                    "level": "error",
                    "message": f"{method} {safe_url} -> FAILED",
                }
            )
            raise
        if resp.status_code >= 400:
            add_breadcrumb(
                {
                    "category": "http",
                    "level": "warning",
                    "message": f"{method} {safe_url} -> {resp.status_code}",
                }
            )
        return resp

    wrapped._inariwatch_wrapped = True  # type: ignore[attr-defined]
    session_cls.request = wrapped  # type: ignore[assignment]


def _try_patch_httpx() -> None:
    try:
        import httpx  # type: ignore[import-not-found]
    except ImportError:
        return

    client_cls = httpx.Client
    if getattr(client_cls.send, "_inariwatch_wrapped", False):
        return

    orig_send = client_cls.send

    def wrapped(self, request, **kwargs):  # type: ignore[no-untyped-def]
        safe_url = scrub_url(str(request.url))
        method = request.method
        add_breadcrumb(
            {"category": "http", "level": "info", "message": f"{method} {safe_url}"}
        )
        try:
            resp = orig_send(self, request, **kwargs)
        except Exception:
            add_breadcrumb(
                {
                    "category": "http",
                    "level": "error",
                    "message": f"{method} {safe_url} -> FAILED",
                }
            )
            raise
        if resp.status_code >= 400:
            add_breadcrumb(
                {
                    "category": "http",
                    "level": "warning",
                    "message": f"{method} {safe_url} -> {resp.status_code}",
                }
            )
        return resp

    wrapped._inariwatch_wrapped = True  # type: ignore[attr-defined]
    client_cls.send = wrapped  # type: ignore[assignment]


def init_breadcrumbs(*, intercept_logging: bool = True) -> None:
    """Install auto-intercept. Called once from ``init()``. Idempotent."""
    global _initialized
    if _initialized:
        return
    _initialized = True

    if intercept_logging:
        root = logging.getLogger()
        # Install at WARNING by default — capturing every DEBUG/INFO would
        # flood the ring buffer. Users who want finer capture can call
        # ``add_breadcrumb`` manually.
        handler = _BreadcrumbLoggingHandler(level=logging.WARNING)
        # Do not attach a formatter — handler.format falls back to
        # record.getMessage() which matches the Node "rendered message" shape.
        root.addHandler(handler)

    _try_patch_requests()
    _try_patch_httpx()


def _reset_for_testing() -> None:
    """Undo ``init_breadcrumbs`` side-effects for unit tests."""
    global _initialized
    _initialized = False
    root = logging.getLogger()
    for h in list(root.handlers):
        if isinstance(h, _BreadcrumbLoggingHandler):
            root.removeHandler(h)
    clear_breadcrumbs()


__all__ = [
    "add_breadcrumb",
    "clear_breadcrumbs",
    "get_breadcrumbs",
    "init_breadcrumbs",
    "scrub_url",
]
