"""On-throw forensic capture — Python equivalent of ``@inariwatch/capture-forensic``.

Public surface:

    register_forensic_hook(hook, options=None) -> {"mode": "pep669" | "settrace"}
    unregister_forensic_hook() -> None

The hook receives a :class:`ForensicCapture` (TypedDict). Its JSON shape
is byte-compatible with the Node ``ForensicCapture`` so a downstream
consumer treating both languages can ``json.loads`` either side and read
the same keys with the same types.

Resolution order:

1. **PEP 669** (``sys.monitoring``) on Python 3.12+. The ``RAISE`` event
   fires synchronously at the throw site — no ``settrace`` overhead, no
   need for the Debugger domain like Node's inspector fallback.
2. **``sys.settrace`` fallback** for 3.10/3.11 *and* for tests that need
   to force the slow path (`force_fallback=True`).

Per-frame we capture:

* ``locals``   — names from ``co_varnames`` (the frame's own bindings).
* ``closure``  — names from ``co_freevars`` (captured from outer scope).
* ``receiver`` — ``self`` if the frame is a method.

Globals are *not* dumped wholesale — they're a process-wide namespace
and would balloon the payload. We only surface ``co_names`` references
indirectly via the source slice (handled at the SDK layer).

Optional companions, both opt-in:

* :data:`faulthandler` — enabled when the hook registers, dumps Python
  tracebacks to stderr on SIGSEGV / SIGFPE / SIGABRT / SIGBUS / SIGILL.
* :data:`tracemalloc` — when ``INARIWATCH_TRACEMALLOC=true``, attaches
  the top 10 allocations at capture time as ``capture["tracemallocTop"]``.

Zero runtime deps. Stdlib only.
"""

from __future__ import annotations

import faulthandler
import os
import re
import sys
import threading
import time
from collections.abc import Callable
from types import FrameType
from typing import Any, TypedDict

from .breadcrumbs import _SECRET_PATTERNS  # noqa: PLC2701 - shared scrub patterns

# ── Public types ────────────────────────────────────────────────────────


class ForensicValue(TypedDict, total=False):
    """One local / closure slot. Mirrors the Node ``ForensicValue`` shape."""

    name: str
    repr: str
    kind: str
    truncated: bool


class FrameSnapshot(TypedDict, total=False):
    """One frame in the captured stack, innermost-first."""

    index: int
    functionName: str
    sourceUrl: str
    line: int
    column: int
    locals: list[ForensicValue]
    closure: list[ForensicValue]
    receiver: ForensicValue
    partial: bool


class TracemallocStat(TypedDict):
    filename: str
    lineno: int
    size: int
    count: int


class ForensicCapture(TypedDict, total=False):
    """Payload handed to the user's hook on every captured throw."""

    frames: list[FrameSnapshot]
    error: BaseException
    sessionId: str
    pid: int
    tid: int
    tsNs: int
    source: str  # "pep669" | "settrace"
    captureDurationMs: float
    tracemallocTop: list[TracemallocStat]


class ForensicOptions(TypedDict, total=False):
    """Knobs for :func:`register_forensic_hook`. All fields optional."""

    maxFrames: int
    maxLocalsPerFrame: int
    maxValueDepth: int
    maxValueBytes: int
    captureBudgetMs: float
    forceFallback: bool
    enableFaulthandler: bool
    enableTracemalloc: bool
    rethrowHookErrors: bool


# ── Defaults (mirror Node ``DEFAULT_OPTIONS``) ──────────────────────────

_DEFAULTS: dict[str, Any] = {
    "maxFrames": 32,
    "maxLocalsPerFrame": 50,
    "maxValueDepth": 2,
    "maxValueBytes": 1024,
    # Node's capture-forensic uses 5ms because V8 + the inspector's
    # RemoteObject preview is largely native-fast. The CPython path runs
    # five regex substitutions per scrubbed string, so the same budget
    # would drop locals on the second large value. 50ms is the empirical
    # ceiling that captures all locals on a 5-value frame on Windows
    # CPython 3.12 without dragging steady-state overhead.
    "captureBudgetMs": 50.0,
    "forceFallback": False,
    "enableFaulthandler": True,
    "enableTracemalloc": False,
    "rethrowHookErrors": False,
}

_TOOL_NAME = "inariwatch-forensic"
_TRACEMALLOC_ENV = "INARIWATCH_TRACEMALLOC"
_TRACEMALLOC_TOP_N = 10

# Match the names monitoring.py considers sensitive. Kept in sync deliberately.
_SECRET_KEY_PATTERNS = re.compile(
    r"(password|passwd|pass|secret|token|api[_-]?key|access[_-]?token|"
    r"refresh[_-]?token|credit[_-]?card|card[_-]?number|cvv|cvc|ssn|"
    r"authorization|cookie|session)",
    re.IGNORECASE,
)


# ── Module state ────────────────────────────────────────────────────────

_lock = threading.Lock()
_hook: Callable[[ForensicCapture], None] | None = None
_options: dict[str, Any] = dict(_DEFAULTS)
_mode: str | None = None  # "pep669" | "settrace"
_pep669_tool_id: int | None = None
_settrace_prev: Any = None  # sys.gettrace() before our install
_faulthandler_was_enabled = False
_tracemalloc_started_by_us = False

# PEP 669 fires RAISE for every frame an exception unwinds through.
# settrace's "exception" event behaves the same way. We only want to
# fire the user hook once — at the innermost throw site — so we keep a
# bounded set of exception ids we've already captured. Cleared on
# unregister; a 128-entry cap prevents an adversarial loop from growing
# memory unbounded.
_seen_exceptions: dict[int, bool] = {}
_SEEN_CAP = 128


# ── Bounded serializer (port of capture-forensic/src/serialize.ts) ──────


class _Budget:
    __slots__ = ("remaining_bytes", "max_depth")

    def __init__(self, max_bytes: int, max_depth: int) -> None:
        self.remaining_bytes = max_bytes
        self.max_depth = max_depth


def _truncate_string(s: str, budget: _Budget) -> tuple[str, bool]:
    if len(s) <= budget.remaining_bytes:
        budget.remaining_bytes -= len(s)
        return s, False
    cut = max(0, budget.remaining_bytes - 1)
    budget.remaining_bytes = 0
    return s[:cut] + "…", True


def _scrub_string(text: str) -> str:
    out = text
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    return out


def _kind_of(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, bytes):
        return "object:bytes"
    if isinstance(value, bytearray):
        return "object:bytearray"
    if isinstance(value, list):
        return "array"
    if isinstance(value, tuple):
        return "array"
    if isinstance(value, dict):
        return f"object:{type(value).__name__}"
    if isinstance(value, BaseException):
        return "error"
    if callable(value):
        return "function"
    cls_name = type(value).__name__
    return f"object:{cls_name}"


def _repr_primitive(value: Any, budget: _Budget) -> tuple[str, bool, str]:
    if value is None:
        return "null", False, "null"
    if isinstance(value, bool):
        return ("true" if value else "false"), False, "boolean"
    if isinstance(value, (int, float)):
        out, trunc = _truncate_string(repr(value), budget)
        return out, trunc, "number"
    if isinstance(value, str):
        # JSON-ish quoted form, like Node's JSON.stringify.
        try:
            quoted = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
        except Exception:
            quoted = '"<unreprable str>"'
        out, trunc = _truncate_string(_scrub_string(quoted), budget)
        return out, trunc, "string"
    if callable(value) and not isinstance(value, type):
        name = getattr(value, "__name__", "<anonymous>")
        out, trunc = _truncate_string(f"[Function: {name}]", budget)
        return out, trunc, "function"
    if isinstance(value, type):
        name = getattr(value, "__name__", "<class>")
        out, trunc = _truncate_string(f"[Class: {name}]", budget)
        return out, trunc, "function"
    return "", False, "unknown"


def _repr_object(
    value: Any,
    depth: int,
    budget: _Budget,
    seen: set[int],
) -> tuple[str, bool, str]:
    obj_id = id(value)
    if obj_id in seen:
        out, trunc = _truncate_string("[Circular]", budget)
        return out, trunc, _kind_of(value)
    seen.add(obj_id)
    try:
        if isinstance(value, BaseException):
            text = f"{type(value).__name__}: {value}"
            out, trunc = _truncate_string(_scrub_string(text), budget)
            return out, trunc, "error"
        if isinstance(value, (bytes, bytearray)):
            preview = repr(bytes(value[:32]))
            out, trunc = _truncate_string(preview, budget)
            return out, trunc, _kind_of(value)
        if depth >= budget.max_depth:
            ctor = type(value).__name__
            out, trunc = _truncate_string(f"[{ctor}]", budget)
            return out, True, f"object:{ctor}"
        if isinstance(value, (list, tuple)):
            parts: list[str] = []
            truncated = False
            for item in value:
                if budget.remaining_bytes <= 3:
                    truncated = True
                    break
                rep, child_trunc, _ = _repr_any(item, depth + 1, budget, seen)
                parts.append(rep)
                if child_trunc:
                    truncated = True
            body = ",".join(parts)
            tail = ",…" if truncated else ""
            return f"[{body}{tail}]", truncated, "array"
        if isinstance(value, dict):
            entries: list[str] = []
            truncated = False
            for key, child in value.items():
                if budget.remaining_bytes <= 3:
                    truncated = True
                    break
                key_str = key if isinstance(key, str) else repr(key)
                if _should_redact_name(str(key)):
                    rep_value, child_trunc = '"[REDACTED]"', False
                else:
                    rep_value, child_trunc, _ = _repr_any(child, depth + 1, budget, seen)
                key_json = '"' + str(key_str).replace('"', '\\"') + '"'
                entries.append(f"{key_json}:{rep_value}")
                if child_trunc:
                    truncated = True
            body = ",".join(entries)
            tail = ",…" if truncated else ""
            ctor = type(value).__name__
            return f"{{{body}{tail}}}", truncated, f"object:{ctor}"
        # Generic object — fall back to a bounded repr().
        try:
            text = repr(value)
        except Exception:
            text = f"<unreprable {type(value).__name__}>"
        out, trunc = _truncate_string(_scrub_string(text), budget)
        ctor = type(value).__name__
        return out, trunc, f"object:{ctor}"
    finally:
        seen.discard(obj_id)


def _repr_any(
    value: Any,
    depth: int,
    budget: _Budget,
    seen: set[int],
) -> tuple[str, bool, str]:
    if value is None or isinstance(value, (bool, int, float, str)) or callable(value):
        # `callable` catches functions and classes; both go through primitive path.
        if not isinstance(value, (list, tuple, dict)):
            return _repr_primitive(value, budget)
    return _repr_object(value, depth, budget, seen)


def _should_redact_name(name: str) -> bool:
    return bool(_SECRET_KEY_PATTERNS.search(name))


def _serialize_value(
    name: str, value: Any, max_bytes: int, max_depth: int
) -> ForensicValue:
    if _should_redact_name(name):
        return {"name": name, "repr": '"[REDACTED]"', "kind": "string"}
    budget = _Budget(max_bytes, max_depth)
    seen: set[int] = set()
    rep, truncated, kind = _repr_any(value, 0, budget, seen)
    out: ForensicValue = {"name": name, "repr": rep, "kind": kind}
    if truncated:
        out["truncated"] = True
    return out


# ── Frame walking ───────────────────────────────────────────────────────


def _looks_internal(filename: str) -> bool:
    """Skip our own forensic / monitoring frames so the stack starts at user code."""
    if "inariwatch_capture" not in filename:
        return False
    return (
        filename.endswith("forensic.py")
        or filename.endswith("monitoring.py")
        or filename.endswith("client.py")
    )


def _build_frame(
    frame: FrameType,
    index: int,
    opts: dict[str, Any],
    deadline_ns: int,
) -> FrameSnapshot:
    code = frame.f_code
    snap: FrameSnapshot = {
        "index": index,
        "functionName": code.co_name or "<anonymous>",
        "sourceUrl": code.co_filename,
        "line": frame.f_lineno,
        "locals": [],
        "closure": [],
    }

    if time.monotonic_ns() > deadline_ns:
        snap["partial"] = True
        return snap

    f_locals = frame.f_locals
    var_names = set(code.co_varnames)
    free_names = set(code.co_freevars)
    cell_names = set(code.co_cellvars)
    max_locals = opts["maxLocalsPerFrame"]
    max_bytes = opts["maxValueBytes"]
    max_depth = opts["maxValueDepth"]

    locals_out: list[ForensicValue] = []
    closure_out: list[ForensicValue] = []
    receiver: ForensicValue | None = None

    # Locals: names declared in this code object. Cellvars (variables this
    # frame creates that inner closures capture) are bound in the local
    # namespace too; we surface them as locals, not closure, so the shape
    # matches Node where the captured-by-closure side is *inbound* only.
    eligible_locals = var_names | cell_names
    for name in eligible_locals:
        if len(locals_out) >= max_locals:
            break
        if time.monotonic_ns() > deadline_ns:
            snap["partial"] = True
            break
        if name not in f_locals:
            continue
        value = f_locals[name]
        if name == "self":
            receiver = _serialize_value("this", value, max_bytes, max_depth)
            continue
        locals_out.append(_serialize_value(name, value, max_bytes, max_depth))

    # Closure: names from outer scopes captured by this function.
    for name in free_names:
        if len(closure_out) + len(locals_out) >= max_locals:
            break
        if time.monotonic_ns() > deadline_ns:
            snap["partial"] = True
            break
        if name not in f_locals:
            # Free variable cell may not be materialized in f_locals on
            # 3.12 unless the function has executed it; fall back to a
            # marker so consumers see *something*.
            closure_out.append(
                {"name": name, "repr": "<unbound>", "kind": "unknown", "truncated": True}
            )
            continue
        value = f_locals[name]
        closure_out.append(_serialize_value(name, value, max_bytes, max_depth))

    snap["locals"] = locals_out
    snap["closure"] = closure_out
    if receiver is not None:
        snap["receiver"] = receiver
    return snap


def _walk_stack(
    start_frame: FrameType | None,
    opts: dict[str, Any],
    deadline_ns: int,
) -> list[FrameSnapshot]:
    frames: list[FrameSnapshot] = []
    cur = start_frame
    max_frames = opts["maxFrames"]
    index = 0
    while cur is not None and index < max_frames:
        if _looks_internal(cur.f_code.co_filename):
            cur = cur.f_back
            continue
        if time.monotonic_ns() > deadline_ns:
            frames.append(
                {
                    "index": index,
                    "functionName": "<budget-exceeded>",
                    "locals": [],
                    "closure": [],
                    "partial": True,
                }
            )
            break
        frames.append(_build_frame(cur, index, opts, deadline_ns))
        index += 1
        cur = cur.f_back
    return frames


# ── Tracemalloc helper ──────────────────────────────────────────────────


def _maybe_take_tracemalloc_top() -> list[TracemallocStat] | None:
    try:
        import tracemalloc  # local import keeps cold-start cheap when disabled
    except ImportError:
        return None
    if not tracemalloc.is_tracing():
        return None
    snapshot = tracemalloc.take_snapshot()
    stats = snapshot.statistics("lineno")[:_TRACEMALLOC_TOP_N]
    return [
        {
            "filename": stat.traceback[0].filename if stat.traceback else "<unknown>",
            "lineno": stat.traceback[0].lineno if stat.traceback else 0,
            "size": int(stat.size),
            "count": int(stat.count),
        }
        for stat in stats
    ]


# ── Faulthandler / tracemalloc lifecycle ────────────────────────────────


def _enable_faulthandler() -> None:
    global _faulthandler_was_enabled
    if faulthandler.is_enabled():
        _faulthandler_was_enabled = True
        return
    try:
        faulthandler.enable(file=sys.stderr, all_threads=True)
        _faulthandler_was_enabled = False
    except (RuntimeError, ValueError):
        # File may not have a real fileno (notebook stdout). Nothing to do.
        return


def _maybe_start_tracemalloc(opts: dict[str, Any]) -> None:
    global _tracemalloc_started_by_us
    enabled = opts.get("enableTracemalloc", False) or os.environ.get(
        _TRACEMALLOC_ENV, ""
    ).lower() in ("1", "true", "yes")
    if not enabled:
        return
    try:
        import tracemalloc
    except ImportError:
        return
    if tracemalloc.is_tracing():
        return
    tracemalloc.start(25)  # 25-frame allocation traceback depth
    _tracemalloc_started_by_us = True


def _stop_tracemalloc_if_we_started() -> None:
    global _tracemalloc_started_by_us
    if not _tracemalloc_started_by_us:
        return
    try:
        import tracemalloc

        tracemalloc.stop()
    except Exception:
        pass
    _tracemalloc_started_by_us = False


# ── Capture dispatch (shared between PEP 669 + settrace) ────────────────


def _dispatch_capture(
    exception: BaseException,
    raise_frame: FrameType | None,
    source: str,
) -> None:
    """Build a ForensicCapture and invoke the user hook.

    Deduplicates on ``id(exception)`` so we capture once at the innermost
    raise site, not again for each frame the exception unwinds through.
    """
    if _hook is None:
        return
    key = id(exception)
    with _lock:
        if key in _seen_exceptions:
            return
        if len(_seen_exceptions) >= _SEEN_CAP:
            # Drop oldest entry — bounded memory.
            _seen_exceptions.pop(next(iter(_seen_exceptions)), None)
        _seen_exceptions[key] = True
    start_ns = time.monotonic_ns()
    deadline_ns = start_ns + int(_options["captureBudgetMs"] * 1_000_000)
    try:
        frames = _walk_stack(raise_frame, _options, deadline_ns)
    except Exception:
        frames = [
            {
                "index": 0,
                "functionName": "<capture-failed>",
                "locals": [],
                "closure": [],
                "partial": True,
            }
        ]
    end_ns = time.monotonic_ns()
    capture: ForensicCapture = {
        "frames": frames,
        "error": exception,
        "pid": os.getpid(),
        "tid": threading.get_ident(),
        "tsNs": start_ns,
        "source": source,
        "captureDurationMs": (end_ns - start_ns) / 1_000_000.0,
    }

    tm_top = _maybe_take_tracemalloc_top()
    if tm_top:
        capture["tracemallocTop"] = tm_top

    try:
        _hook(capture)
    except Exception:
        if _options.get("rethrowHookErrors"):
            raise
        # Otherwise: swallow. We must never propagate out of monitoring.


# ── PEP 669 path ────────────────────────────────────────────────────────


def _on_raise_pep669(code, instruction_offset, exception):  # type: ignore[no-untyped-def]
    # `sys._getframe(1)` is the frame that executed the raise. Skip our
    # own machinery (depth 0 is this callback).
    try:
        frame: FrameType | None = sys._getframe(1)
    except ValueError:
        frame = None
    _dispatch_capture(exception, frame, "pep669")


def _install_pep669() -> bool:
    global _pep669_tool_id
    monitoring = getattr(sys, "monitoring", None)
    if monitoring is None:
        return False
    # IDs 3-4 are claimed by monitoring.py for the auto-monitoring path.
    # Try 5 first so both can coexist.
    for candidate in (5, 4, 3):
        try:
            monitoring.use_tool_id(candidate, _TOOL_NAME)
            _pep669_tool_id = candidate
            break
        except (ValueError, RuntimeError):
            continue
    if _pep669_tool_id is None:
        return False
    events = monitoring.events
    monitoring.set_events(_pep669_tool_id, events.RAISE)
    monitoring.register_callback(_pep669_tool_id, events.RAISE, _on_raise_pep669)
    return True


def _uninstall_pep669() -> None:
    global _pep669_tool_id
    monitoring = getattr(sys, "monitoring", None)
    if monitoring is None or _pep669_tool_id is None:
        return
    try:
        monitoring.set_events(_pep669_tool_id, 0)
        monitoring.register_callback(_pep669_tool_id, monitoring.events.RAISE, None)
        monitoring.free_tool_id(_pep669_tool_id)
    except (ValueError, RuntimeError):
        pass
    _pep669_tool_id = None


# ── settrace fallback ───────────────────────────────────────────────────


def _trace_fn(frame: FrameType, event: str, arg: Any):
    if event == "exception" and isinstance(arg, tuple) and len(arg) == 3:
        _, exc, _tb = arg
        if isinstance(exc, BaseException):
            _dispatch_capture(exc, frame, "settrace")
    return _trace_fn


def _install_settrace() -> bool:
    global _settrace_prev
    _settrace_prev = sys.gettrace()
    sys.settrace(_trace_fn)
    try:
        threading.settrace(_trace_fn)
    except AttributeError:
        pass
    return True


def _uninstall_settrace() -> None:
    global _settrace_prev
    sys.settrace(_settrace_prev)
    try:
        threading.settrace(None)  # type: ignore[arg-type]
    except (AttributeError, TypeError):
        pass
    _settrace_prev = None


# ── Public API ──────────────────────────────────────────────────────────


def register_forensic_hook(
    hook: Callable[[ForensicCapture], None],
    options: ForensicOptions | None = None,
) -> dict[str, str]:
    """Register a single forensic hook for the process.

    Resolution order:

    1. PEP 669 ``sys.monitoring`` if available and ``forceFallback`` is
       not set.
    2. ``sys.settrace`` fallback otherwise.

    Calling twice raises :class:`RuntimeError` — call
    :func:`unregister_forensic_hook` first.

    Returns ``{"mode": "pep669"}`` or ``{"mode": "settrace"}``.
    """
    global _hook, _options, _mode

    if _mode is not None:
        raise RuntimeError("inariwatch-capture forensic hook already registered")

    merged: dict[str, Any] = dict(_DEFAULTS)
    if options:
        merged.update({k: v for k, v in options.items() if v is not None})

    with _lock:
        _hook = hook
        _options = merged

        if merged.get("enableFaulthandler", True):
            _enable_faulthandler()

        _maybe_start_tracemalloc(merged)

        force_fallback = bool(merged.get("forceFallback"))
        installed_pep669 = False
        if not force_fallback:
            try:
                installed_pep669 = _install_pep669()
            except Exception:
                installed_pep669 = False

        if installed_pep669:
            _mode = "pep669"
        else:
            _install_settrace()
            _mode = "settrace"

    return {"mode": _mode}


def unregister_forensic_hook() -> None:
    """Remove the hook and tear down probes. Idempotent."""
    global _hook, _mode

    with _lock:
        if _mode == "pep669":
            _uninstall_pep669()
        elif _mode == "settrace":
            _uninstall_settrace()
        _stop_tracemalloc_if_we_started()
        _seen_exceptions.clear()
        _hook = None
        _mode = None


def __mode() -> str | None:
    """Exposed for tests + debugging."""
    return _mode


__all__ = [
    "ForensicCapture",
    "ForensicOptions",
    "ForensicValue",
    "FrameSnapshot",
    "TracemallocStat",
    "register_forensic_hook",
    "unregister_forensic_hook",
]
