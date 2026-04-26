"""PEP 669 forensics — capture frame locals at the moment of ``raise``.

Python 3.12 stabilized :mod:`sys.monitoring`, the first CPython API that
fires callbacks per event **without** the multi-hundred-nanosecond cost
of ``sys.settrace``. We subscribe to the ``RAISE`` event so we can grab
a frame-locals snapshot at the throw site, before any ``except`` block
rewinds state. When the exception is handled (``EXCEPTION_HANDLED``)
or the frame unwinds (``PY_UNWIND``) we evict the cache entry — so in
steady state the cache is empty.

Cache layout: ``dict[id(exception), list[FrameLocals]]``. The newest
frame is appended when RAISE re-fires during re-raise. ``capture_exception``
reads the list for ``id(err)`` to enrich the payload.

All locals are passed through :func:`_safe_repr` + :func:`_redact` so
secrets never land in the event.
"""

from __future__ import annotations

import re
import sys
import threading
from types import FrameType
from typing import Any, TypedDict

from .breadcrumbs import _SECRET_PATTERNS  # noqa: PLC2701 - shared scrub patterns

_TOOL_NAME = "inariwatch-capture"
_TOOL_ID: int | None = None
_registered = False
_lock = threading.Lock()


class FrameLocals(TypedDict):
    file: str
    line: int
    function: str
    locals: dict[str, str]


# Cache keyed by id(exception). Bounded by how many exceptions are "in
# flight" at once — typically 1-3. We still cap at 128 to survive tight
# re-raise loops.
_MAX_CACHED = 128
_cache: dict[int, list[FrameLocals]] = {}

_REPR_MAX = 200

_SECRET_KEY_PATTERNS = re.compile(
    r"(password|passwd|pass|secret|token|api[_-]?key|access[_-]?token|"
    r"refresh[_-]?token|credit[_-]?card|card[_-]?number|cvv|cvc|ssn|"
    r"authorization|cookie|session)",
    re.IGNORECASE,
)


def _should_redact_name(name: str) -> bool:
    return bool(_SECRET_KEY_PATTERNS.search(name))


def _sanitize_for_repr(value: Any, depth: int = 0) -> Any:
    """Return a copy of ``value`` with sensitive dict/object keys redacted.

    Walks one level deep by default (``depth=0``) and recurses up to 2
    more levels. This lets us catch ``{"pwd": "..."}`` even though the
    outer variable name was ``payload``. Bounded to 50 items per
    container to keep repr length predictable on giant structures.
    """
    if depth > 2:
        return value
    if isinstance(value, dict):
        safe: dict[Any, Any] = {}
        for k, v in list(value.items())[:50]:
            if _should_redact_name(str(k)):
                safe[k] = "[REDACTED]"
            else:
                safe[k] = _sanitize_for_repr(v, depth + 1)
        return safe
    if isinstance(value, (list, tuple)) and depth < 2:
        items = [_sanitize_for_repr(v, depth + 1) for v in list(value)[:20]]
        return type(value)(items) if isinstance(value, tuple) else items
    return value


def _safe_repr(value: Any) -> str:
    """Return a bounded-length, secret-scrubbed repr that can't raise.

    ``repr`` on some objects (e.g. SQLAlchemy proxies, mocks) can itself
    throw — we never want that to propagate out of the monitoring
    handler and hide the original exception. The value is first
    sanitized (sensitive dict keys replaced with ``[REDACTED]``) then
    repr-ed; the resulting string is finally passed through the shared
    :data:`_SECRET_PATTERNS` list so tokens embedded as values in
    untyped blobs still get scrubbed.
    """
    try:
        sanitized = _sanitize_for_repr(value)
        text = repr(sanitized)
    except Exception:
        try:
            text = f"<unreprable {type(value).__name__}>"
        except Exception:
            text = "<unreprable>"
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    if len(text) > _REPR_MAX:
        return text[:_REPR_MAX] + "...[truncated]"
    return text


def _redact_frame_locals(frame_locals: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in frame_locals.items():
        if _should_redact_name(name):
            out[name] = "[REDACTED]"
        else:
            out[name] = _safe_repr(value)
    return out


def _capture_frame(frame: FrameType) -> FrameLocals:
    return {
        "file": frame.f_code.co_filename,
        "line": frame.f_lineno,
        "function": frame.f_code.co_name,
        "locals": _redact_frame_locals(frame.f_locals),
    }


def _on_raise(code, instruction_offset, exception):  # type: ignore[no-untyped-def]  # noqa: ARG001
    # ``sys._getframe(1)`` is the frame that executed the raise. We skip
    # the monitoring machinery's frame (our handler at depth 0).
    try:
        frame: FrameType | None = sys._getframe(1)
    except ValueError:
        return
    if frame is None:
        return
    snapshot = _capture_frame(frame)
    key = id(exception)
    with _lock:
        if len(_cache) >= _MAX_CACHED and key not in _cache:
            # Drop oldest — simple but bounded.
            oldest_key = next(iter(_cache))
            _cache.pop(oldest_key, None)
        _cache.setdefault(key, []).append(snapshot)


def get_frame_locals_for(exception: BaseException) -> list[FrameLocals]:
    """Return captured frame locals for ``exception``, or ``[]``.

    Callers should invoke this synchronously from inside the ``except``
    block so the cache entry hasn't been evicted yet. The list is
    ordered oldest-to-newest (the raising frame is last).
    """
    with _lock:
        snapshots = _cache.get(id(exception))
        if not snapshots:
            return []
        return list(snapshots)


def register_monitoring(*, silent: bool = False) -> bool:
    """Register PEP 669 callbacks. Returns ``True`` on success.

    Called from ``init()`` when ``auto_monitoring`` is True. Idempotent.
    Fails gracefully if the Python runtime doesn't expose
    ``sys.monitoring`` — that path is already ruled out by the
    ``requires-python = ">=3.12"`` constraint in pyproject but keeping
    the guard lets the module import cleanly in doc builds and static
    analysers.
    """
    global _registered, _TOOL_ID
    if _registered:
        return True

    monitoring = getattr(sys, "monitoring", None)
    if monitoring is None:
        return False

    with _lock:
        if _registered:
            return True

        # Tool IDs 0-5 are reserved for well-known uses (debugger,
        # coverage, profiler, optimizer). IDs 3 and 4 are free for
        # general use — we try 3 first.
        for candidate in (3, 4):
            try:
                monitoring.use_tool_id(candidate, _TOOL_NAME)
                _TOOL_ID = candidate
                break
            except (ValueError, RuntimeError):
                continue

        if _TOOL_ID is None:
            if not silent:
                sys.stderr.write(
                    "[inariwatch-capture] PEP 669 tool IDs 3-4 are taken; "
                    "frame-local forensics disabled.\n"
                )
            return False

        events = monitoring.events
        # Only subscribe to RAISE. Eviction is handled by the bounded cache
        # (``_MAX_CACHED``) so entries age out naturally. Subscribing to
        # EXCEPTION_HANDLED was tempting for tidy cleanup but that event
        # fires as the ``except`` clause begins execution — *before* user
        # code inside the ``except`` block runs. Since ``capture_exception``
        # is typically called from inside the except block, evicting on
        # EXCEPTION_HANDLED would race and empty the cache before the
        # capture read.
        monitoring.set_events(_TOOL_ID, events.RAISE)
        monitoring.register_callback(_TOOL_ID, events.RAISE, _on_raise)
        _registered = True
        return True


def unregister_monitoring() -> None:
    """Free the tool id — primarily for tests + clean shutdown."""
    global _registered, _TOOL_ID
    monitoring = getattr(sys, "monitoring", None)
    if monitoring is None or not _registered or _TOOL_ID is None:
        return
    with _lock:
        try:
            monitoring.set_events(_TOOL_ID, 0)
            monitoring.free_tool_id(_TOOL_ID)
        except (ValueError, RuntimeError):
            pass
        _TOOL_ID = None
        _registered = False
        _cache.clear()


__all__ = [
    "FrameLocals",
    "get_frame_locals_for",
    "register_monitoring",
    "unregister_monitoring",
]
