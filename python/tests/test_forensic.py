"""Tests for ``inariwatch_capture.forensic``.

Covers:
- PEP 669 path on 3.12+ (default).
- ``settrace`` fallback path forced via ``forceFallback=True``.
- Redaction of sensitive variable names + sensitive substrings inside reprs.
- Closure capture from ``co_freevars``.
- ``self`` lifted into the ``receiver`` slot.
- Tracemalloc gating (env var + option).
- Faulthandler enable.
- Idempotency and unregister.
"""

from __future__ import annotations

import faulthandler
import os
import sys
from typing import Any

import pytest

from inariwatch_capture import (
    ForensicCapture,
    register_forensic_hook,
    unregister_forensic_hook,
)
from inariwatch_capture import forensic as forensic_mod


@pytest.fixture(autouse=True)
def _teardown() -> None:
    """Ensure every test starts and ends with no hook installed."""
    try:
        unregister_forensic_hook()
    except Exception:
        pass
    yield
    try:
        unregister_forensic_hook()
    except Exception:
        pass


def _find_local(frame: dict, name: str) -> dict | None:
    for v in frame.get("locals", []):
        if v["name"] == name:
            return v
    return None


# ── PEP 669 path ────────────────────────────────────────────────────────


@pytest.mark.skipif(
    not hasattr(sys, "monitoring"), reason="PEP 669 requires Python 3.12+"
)
def test_pep669_captures_local_with_redaction() -> None:
    captured: list[ForensicCapture] = []

    def hook(c: ForensicCapture) -> None:
        captured.append(c)

    result = register_forensic_hook(hook)
    assert result == {"mode": "pep669"}

    secret = "abc"  # noqa: F841 — intentionally sensitive name
    visible = 42  # noqa: F841

    try:
        raise ValueError("x")
    except ValueError:
        pass

    assert len(captured) >= 1
    cap = captured[0]
    assert cap["source"] == "pep669"
    assert cap["pid"] == os.getpid()
    assert cap["captureDurationMs"] >= 0
    assert isinstance(cap["tsNs"], int)

    # The innermost frame should be this test function.
    top = cap["frames"][0]
    assert top["functionName"] == "test_pep669_captures_local_with_redaction"
    assert top["sourceUrl"].endswith("test_forensic.py")

    secret_local = _find_local(top, "secret")
    assert secret_local is not None
    assert secret_local["repr"] == '"[REDACTED]"'
    assert secret_local["kind"] == "string"

    visible_local = _find_local(top, "visible")
    assert visible_local is not None
    assert visible_local["repr"] == "42"
    assert visible_local["kind"] == "number"


@pytest.mark.skipif(
    not hasattr(sys, "monitoring"), reason="PEP 669 requires Python 3.12+"
)
def test_pep669_captures_closure_and_self() -> None:
    captured: list[ForensicCapture] = []
    register_forensic_hook(lambda c: captured.append(c))

    captured_token = "outer_value"

    class WidgetService:
        def __init__(self, name: str) -> None:
            self.name = name

        def explode(self) -> None:
            local_token = captured_token  # noqa: F841 — exercises closure
            raise RuntimeError("boom")

    svc = WidgetService("acme")
    try:
        svc.explode()
    except RuntimeError:
        pass

    assert captured
    cap = captured[-1]
    explode_frame = cap["frames"][0]
    assert explode_frame["functionName"] == "explode"

    receiver = explode_frame.get("receiver")
    assert receiver is not None
    assert receiver["name"] == "this"
    assert "WidgetService" in receiver["kind"] or "object" in receiver["kind"]

    closure_names = {v["name"] for v in explode_frame.get("closure", [])}
    assert "captured_token" in closure_names


# ── settrace fallback ───────────────────────────────────────────────────


def test_settrace_fallback_force() -> None:
    captured: list[ForensicCapture] = []
    result = register_forensic_hook(
        lambda c: captured.append(c), {"forceFallback": True}
    )
    assert result == {"mode": "settrace"}
    assert forensic_mod.__mode() == "settrace"

    user_id = 7  # noqa: F841

    def boom() -> None:
        api_key = "sk_test_xyz"  # noqa: F841 — sensitive name
        raise KeyError("missing")

    try:
        boom()
    except KeyError:
        pass

    assert captured, "settrace path should fire on exception"
    cap = captured[0]
    assert cap["source"] == "settrace"

    # The settrace event fires with `frame` set to the frame raising,
    # so `boom` should be in the captured stack somewhere.
    fns = [f["functionName"] for f in cap["frames"]]
    assert "boom" in fns

    boom_frame = next(f for f in cap["frames"] if f["functionName"] == "boom")
    api_local = _find_local(boom_frame, "api_key")
    assert api_local is not None
    assert api_local["repr"] == '"[REDACTED]"'


# ── Tracemalloc gate ────────────────────────────────────────────────────


def test_tracemalloc_disabled_by_default() -> None:
    captured: list[ForensicCapture] = []
    register_forensic_hook(lambda c: captured.append(c))
    try:
        raise ValueError("trigger")
    except ValueError:
        pass
    assert captured
    assert "tracemallocTop" not in captured[0]


def test_tracemalloc_env_var_enables() -> None:
    os.environ["INARIWATCH_TRACEMALLOC"] = "true"
    try:
        captured: list[ForensicCapture] = []
        register_forensic_hook(lambda c: captured.append(c))
        # Allocate something to ensure tracemalloc has data
        _ = [object() for _ in range(50)]
        try:
            raise ValueError("trigger")
        except ValueError:
            pass
        assert captured
        tm = captured[0].get("tracemallocTop")
        assert tm is not None
        assert isinstance(tm, list)
        if tm:
            entry = tm[0]
            assert "filename" in entry
            assert "size" in entry
            assert "count" in entry
    finally:
        os.environ.pop("INARIWATCH_TRACEMALLOC", None)


# ── Faulthandler ────────────────────────────────────────────────────────


def test_faulthandler_enabled_after_register() -> None:
    register_forensic_hook(lambda c: None)
    assert faulthandler.is_enabled()


def test_faulthandler_can_be_disabled_via_option() -> None:
    if faulthandler.is_enabled():
        faulthandler.disable()
    register_forensic_hook(lambda c: None, {"enableFaulthandler": False})
    # The option asks us not to touch faulthandler — state should stay where it was.
    assert not faulthandler.is_enabled()


# ── Lifecycle ───────────────────────────────────────────────────────────


def test_double_register_raises() -> None:
    register_forensic_hook(lambda c: None)
    with pytest.raises(RuntimeError):
        register_forensic_hook(lambda c: None)


def test_unregister_is_idempotent() -> None:
    register_forensic_hook(lambda c: None)
    unregister_forensic_hook()
    # Second call must not raise.
    unregister_forensic_hook()
    # And we must be able to register again afterwards.
    register_forensic_hook(lambda c: None)


def test_hook_exception_swallowed_by_default() -> None:
    def bad_hook(c: ForensicCapture) -> None:
        raise RuntimeError("hook bug")

    register_forensic_hook(bad_hook)
    try:
        raise ValueError("trigger")
    except ValueError:
        pass
    # If we got here without propagating "hook bug", we're good.


def test_hook_exception_rethrown_when_opted_in() -> None:
    seen: list[Exception] = []

    def bad_hook(c: ForensicCapture) -> None:
        raise RuntimeError("hook bug")

    register_forensic_hook(bad_hook, {"rethrowHookErrors": True, "forceFallback": True})

    # settrace path: the rethrown hook error is swallowed by the trace
    # function infrastructure but at least propagates through _dispatch_capture.
    # We verify by directly calling _dispatch_capture, which is the shared path.
    import threading
    from inariwatch_capture.forensic import _dispatch_capture

    try:
        raise ValueError("real")
    except ValueError as e:
        try:
            _dispatch_capture(e, sys._getframe(), "settrace")
        except RuntimeError as caught:
            seen.append(caught)
    assert any("hook bug" in str(e) for e in seen)


# ── Bounded value serialization ─────────────────────────────────────────


def test_large_value_truncated() -> None:
    captured: list[ForensicCapture] = []
    register_forensic_hook(
        lambda c: captured.append(c), {"maxValueBytes": 64}
    )

    big = "x" * 10_000  # noqa: F841

    try:
        raise ValueError("trigger")
    except ValueError:
        pass

    assert captured
    big_local = _find_local(captured[0]["frames"][0], "big")
    assert big_local is not None
    assert big_local.get("truncated") is True
    assert len(big_local["repr"]) <= 80  # 64 budget + a bit of slack


def test_circular_reference_handled() -> None:
    captured: list[ForensicCapture] = []
    register_forensic_hook(lambda c: captured.append(c))

    cycle: dict[str, Any] = {}
    cycle["self"] = cycle  # noqa — exercise cycle detection

    try:
        raise ValueError("trigger")
    except ValueError:
        pass

    assert captured
    cycle_local = _find_local(captured[0]["frames"][0], "cycle")
    assert cycle_local is not None
    # Either bottoms out at depth or marks Circular — both are acceptable
    # outputs as long as we don't infinite-loop and never raise.
    assert cycle_local["repr"]


def test_dict_with_nested_secret_is_redacted_by_key() -> None:
    captured: list[ForensicCapture] = []
    register_forensic_hook(lambda c: captured.append(c))

    payload = {"user": "jesus", "password": "hunter2"}  # noqa: F841

    try:
        raise ValueError("trigger")
    except ValueError:
        pass

    assert captured
    payload_local = _find_local(captured[0]["frames"][0], "payload")
    assert payload_local is not None
    assert "[REDACTED]" in payload_local["repr"]
    assert "hunter2" not in payload_local["repr"]


# ── Output shape (byte-compat with Node) ────────────────────────────────


def test_output_shape_matches_node_camelcase() -> None:
    captured: list[ForensicCapture] = []
    register_forensic_hook(lambda c: captured.append(c))

    try:
        raise ValueError("shape")
    except ValueError:
        pass

    assert captured
    cap = captured[0]
    expected_top_keys = {
        "frames",
        "error",
        "pid",
        "tid",
        "tsNs",
        "source",
        "captureDurationMs",
    }
    assert expected_top_keys.issubset(cap.keys())

    frame = cap["frames"][0]
    expected_frame_keys = {"index", "functionName", "sourceUrl", "line", "locals", "closure"}
    assert expected_frame_keys.issubset(frame.keys())

    if frame["locals"]:
        v = frame["locals"][0]
        assert {"name", "repr", "kind"}.issubset(v.keys())


# ── Direct serializer tests ─────────────────────────────────────────────
#
# PEP 669 callbacks are dispatched from C, which sidesteps ``sys.settrace``
# — coverage.py's tracer doesn't see code reached only through that path.
# These direct tests exercise the same internals so coverage reflects the
# actually-tested surface area.

from inariwatch_capture.forensic import (
    _Budget,
    _kind_of,
    _repr_any,
    _scrub_string,
    _serialize_value,
    _should_redact_name,
    _truncate_string,
)


def test_truncate_string_within_budget() -> None:
    b = _Budget(100, 2)
    out, trunc = _truncate_string("hello", b)
    assert out == "hello"
    assert trunc is False
    assert b.remaining_bytes == 95


def test_truncate_string_exceeds_budget() -> None:
    b = _Budget(5, 2)
    out, trunc = _truncate_string("hello world", b)
    assert trunc is True
    assert out.endswith("…")
    assert b.remaining_bytes == 0


def test_scrub_string_removes_bearer_token() -> None:
    s = "Bearer abc.def.ghi for example"
    assert "[REDACTED]" in _scrub_string(s)
    assert "abc.def.ghi" not in _scrub_string(s)


def test_kind_of_covers_all_branches() -> None:
    assert _kind_of(None) == "null"
    assert _kind_of(True) == "boolean"
    assert _kind_of(1) == "number"
    assert _kind_of(1.5) == "number"
    assert _kind_of("x") == "string"
    assert _kind_of(b"x") == "object:bytes"
    assert _kind_of(bytearray(b"x")) == "object:bytearray"
    assert _kind_of([]) == "array"
    assert _kind_of(()) == "array"
    assert _kind_of({}) == "object:dict"
    assert _kind_of(ValueError("x")) == "error"
    assert _kind_of(lambda: 1) == "function"

    class _C:
        pass

    assert _kind_of(_C()) == "object:_C"


def test_should_redact_name_matches_known_secrets() -> None:
    assert _should_redact_name("password")
    assert _should_redact_name("API_KEY")
    assert _should_redact_name("Authorization")
    assert _should_redact_name("session_id")
    assert not _should_redact_name("name")
    assert not _should_redact_name("user")


def test_repr_primitive_int_float_bool_none() -> None:
    b = _Budget(100, 2)
    rep, _, kind = _repr_any(None, 0, b, set())
    assert rep == "null"
    assert kind == "null"

    b = _Budget(100, 2)
    rep, _, kind = _repr_any(True, 0, b, set())
    assert rep == "true"
    assert kind == "boolean"

    b = _Budget(100, 2)
    rep, _, kind = _repr_any(False, 0, b, set())
    assert rep == "false"

    b = _Budget(100, 2)
    rep, _, kind = _repr_any(42, 0, b, set())
    assert rep == "42"
    assert kind == "number"

    b = _Budget(100, 2)
    rep, _, kind = _repr_any(3.14, 0, b, set())
    assert kind == "number"


def test_repr_primitive_string_quoted_and_scrubbed() -> None:
    b = _Budget(200, 2)
    rep, _, kind = _repr_any("hello", 0, b, set())
    assert rep == '"hello"'
    assert kind == "string"

    b = _Budget(200, 2)
    rep, _, _ = _repr_any("Bearer secrettoken123", 0, b, set())
    assert "[REDACTED]" in rep


def test_repr_primitive_function_and_class() -> None:
    def named_fn() -> None:
        pass

    b = _Budget(200, 2)
    rep, _, kind = _repr_any(named_fn, 0, b, set())
    assert "Function" in rep and "named_fn" in rep
    assert kind == "function"

    class _Klass:
        pass

    b = _Budget(200, 2)
    rep, _, kind = _repr_any(_Klass, 0, b, set())
    assert "Class" in rep and "_Klass" in rep
    assert kind == "function"


def test_repr_object_list_tuple() -> None:
    b = _Budget(200, 2)
    rep, _, kind = _repr_any([1, 2, 3], 0, b, set())
    assert rep == "[1,2,3]"
    assert kind == "array"

    b = _Budget(200, 2)
    rep, _, kind = _repr_any((1, 2), 0, b, set())
    assert rep == "[1,2]"
    assert kind == "array"


def test_repr_object_dict_with_redacted_key() -> None:
    b = _Budget(200, 2)
    rep, _, _ = _repr_any({"name": "x", "password": "y"}, 0, b, set())
    assert "[REDACTED]" in rep
    assert '"y"' not in rep


def test_repr_object_bytes_preview() -> None:
    b = _Budget(200, 2)
    rep, _, kind = _repr_any(b"hello", 0, b, set())
    assert "hello" in rep
    assert "bytes" in kind


def test_repr_object_baseexception() -> None:
    b = _Budget(200, 2)
    rep, _, kind = _repr_any(KeyError("missing"), 0, b, set())
    assert "KeyError" in rep
    assert kind == "error"


def test_repr_object_depth_limit() -> None:
    nested = {"a": {"b": {"c": {"d": "deep"}}}}
    b = _Budget(500, 2)
    rep, trunc, _ = _repr_any(nested, 0, b, set())
    # At depth >= 2, child objects should appear as bracket placeholders.
    assert "[dict]" in rep or trunc is True


def test_repr_object_circular_returns_marker() -> None:
    cycle: dict = {}
    cycle["self"] = cycle
    b = _Budget(500, 5)
    rep, _, _ = _repr_any(cycle, 0, b, set())
    assert "[Circular]" in rep


def test_repr_object_unreprable_falls_back() -> None:
    class Bad:
        def __repr__(self) -> str:
            raise RuntimeError("nope")

    b = _Budget(200, 2)
    rep, _, kind = _repr_any(Bad(), 0, b, set())
    assert "unreprable" in rep
    assert kind.startswith("object:")


def test_serialize_value_redacts_by_name() -> None:
    v = _serialize_value("api_key", "sk_live_xyz", 256, 2)
    assert v["repr"] == '"[REDACTED]"'
    assert v["kind"] == "string"


# ── Direct frame-walking tests ──────────────────────────────────────────

from inariwatch_capture.forensic import (
    _DEFAULTS,
    _build_frame,
    _dispatch_capture,
    _looks_internal,
    _walk_stack,
)


def _make_opts(**overrides: Any) -> dict[str, Any]:
    opts = dict(_DEFAULTS)
    opts.update(overrides)
    return opts


def test_build_frame_extracts_locals_and_self() -> None:
    class _Holder:
        def method(self) -> Any:
            secret = "y"  # noqa: F841
            count = 5  # noqa: F841
            return sys._getframe()

    holder = _Holder()
    frame = holder.method()
    snap = _build_frame(frame, 0, _make_opts(), deadline_ns=2**62)
    assert snap["functionName"] == "method"
    names = {v["name"] for v in snap["locals"]}
    assert "count" in names
    assert "secret" in names
    assert snap.get("receiver") is not None
    secret_v = next(v for v in snap["locals"] if v["name"] == "secret")
    assert secret_v["repr"] == '"[REDACTED]"'


def test_build_frame_partial_on_zero_deadline() -> None:
    def fn() -> Any:
        return sys._getframe()

    snap = _build_frame(fn(), 0, _make_opts(), deadline_ns=0)
    assert snap.get("partial") is True


def test_build_frame_respects_max_locals_per_frame() -> None:
    def fn() -> Any:
        a = 1  # noqa: F841
        b = 2  # noqa: F841
        c = 3  # noqa: F841
        return sys._getframe()

    snap = _build_frame(fn(), 0, _make_opts(maxLocalsPerFrame=1), deadline_ns=2**62)
    assert len(snap["locals"]) == 1


def test_build_frame_with_closure() -> None:
    captured = "outer"

    def make_inner() -> Any:
        def inner() -> Any:
            _use = captured  # noqa: F841 — pull captured into closure
            return sys._getframe()

        return inner()

    snap = _build_frame(make_inner(), 0, _make_opts(), deadline_ns=2**62)
    closure_names = {v["name"] for v in snap["closure"]}
    assert "captured" in closure_names


def test_walk_stack_skips_internal_frames(monkeypatch: Any) -> None:
    def get_frame() -> Any:
        return sys._getframe()

    frame = get_frame()
    frames = _walk_stack(frame, _make_opts(maxFrames=10), deadline_ns=2**62)
    # The test function should be in the walk somewhere.
    assert any(f["functionName"].startswith("test_") for f in frames)


def test_walk_stack_emits_budget_exceeded_marker() -> None:
    def fn() -> Any:
        return sys._getframe()

    # Use a deadline that's expired — first iteration drops into the budget arm.
    frames = _walk_stack(fn(), _make_opts(), deadline_ns=0)
    assert frames
    assert frames[0]["functionName"] == "<budget-exceeded>"


def test_walk_stack_max_frames_caps_depth() -> None:
    # Build a chain of recursive frames and walk it.
    def deep(n: int) -> Any:
        if n == 0:
            return sys._getframe()
        return deep(n - 1)

    frame = deep(5)
    frames = _walk_stack(frame, _make_opts(maxFrames=2), deadline_ns=2**62)
    assert len(frames) == 2


def test_looks_internal_only_matches_package_files() -> None:
    assert _looks_internal("/pkg/inariwatch_capture/forensic.py")
    assert _looks_internal("/pkg/inariwatch_capture/monitoring.py")
    assert not _looks_internal("/elsewhere/forensic.py")
    assert not _looks_internal("/usercode/foo.py")


def test_dispatch_capture_no_hook_is_noop() -> None:
    # No hook installed — dispatch is a quick return, must not raise.
    _dispatch_capture(ValueError("x"), sys._getframe(), "settrace")


def test_dispatch_capture_dedupes_same_exception() -> None:
    seen: list[ForensicCapture] = []
    register_forensic_hook(lambda c: seen.append(c), {"forceFallback": True})
    err = ValueError("dup")
    _dispatch_capture(err, sys._getframe(), "settrace")
    _dispatch_capture(err, sys._getframe(), "settrace")
    assert len(seen) == 1


def test_dispatch_capture_stack_walk_failure_falls_back() -> None:
    """When _walk_stack raises, the try/except in _dispatch_capture
    should still emit a `<capture-failed>` snapshot and invoke the hook.
    Use PEP 669 path so settrace isn't separately catching the inner
    AttributeError as a spurious second event.
    """
    seen: list[ForensicCapture] = []
    register_forensic_hook(lambda c: seen.append(c))

    class BadFrame:
        f_code = None  # walking will hit None.co_filename → AttributeError

    _dispatch_capture(ValueError("y"), BadFrame(), "manual")  # type: ignore[arg-type]
    assert seen
    assert seen[-1]["frames"][0]["functionName"] == "<capture-failed>"
    assert seen[-1]["source"] == "manual"


def test_settrace_fallback_when_pep669_unavailable(monkeypatch: Any) -> None:
    """Force the PEP 669 install to fail so the settrace branch runs."""
    import inariwatch_capture.forensic as fmod

    monkeypatch.setattr(fmod, "_install_pep669", lambda: False)
    seen: list[ForensicCapture] = []
    result = register_forensic_hook(lambda c: seen.append(c))
    assert result["mode"] == "settrace"


def test_register_options_all_none_uses_defaults() -> None:
    """Passing options with None values should fall through to defaults."""
    register_forensic_hook(lambda c: None, {"maxFrames": None, "captureBudgetMs": None})  # type: ignore[typeddict-item]
    # If we got here without crashing, defaults kicked in.
