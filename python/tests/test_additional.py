"""Targeted tests to exercise auxiliary code paths — local transport,
logging handler variants, auto-intercept, client init flows, environment
introspection. Pure top-ups for coverage of paths the main suite
doesn't trip over during typical capture flows."""

from __future__ import annotations

import logging
import os
from typing import Any
from unittest.mock import patch

import pytest

import inariwatch_capture
from inariwatch_capture import breadcrumbs as _b
from inariwatch_capture import client as _client_module
from inariwatch_capture.environment import get_environment_context
from inariwatch_capture.git import (
    _reset_cache_for_testing,  # type: ignore[attr-defined]
    extract_git_info,
    get_git_context,
)
from inariwatch_capture.integrations.logging import InariWatchHandler
from inariwatch_capture.transport import (
    LocalTransport,
    create_local_transport,
    parse_dsn,
    sign_payload,
)


# ── LocalTransport pretty-printer ─────────────────────────────────────


def test_local_transport_emits_to_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    t = LocalTransport()
    t.send(
        {
            "fingerprint": "fp",
            "title": "ValueError: bad",
            "body": "ValueError: bad\n  at frame1\n  at frame2\n  at frame3\n  at frame4\n  at frame5\n  at frame6",
            "severity": "critical",
            "timestamp": "2026-04-24T12:00:00.000Z",
            "context": {"user": "alice"},
        }
    )
    out = capsys.readouterr().err
    assert "CRITICAL" in out
    assert "ValueError: bad" in out
    assert "user" in out  # context rendered


def test_local_transport_handles_unserializable_context(
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Opaque:
        def __repr__(self) -> str:
            return "<opaque>"

    t = LocalTransport()
    t.send(
        {
            "fingerprint": "fp",
            "title": "t",
            "body": "b",
            "severity": "info",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "context": {"obj": Opaque()},
        }
    )
    out = capsys.readouterr().err
    # It either renders <opaque> via default=str, or prints
    # "<unserializable>" — either is fine, just must not crash.
    assert "t" in out


def test_create_local_transport_factory() -> None:
    t = create_local_transport({})
    assert isinstance(t, LocalTransport)


def test_local_transport_flush_is_noop() -> None:
    LocalTransport().flush(timeout=0.1)  # should return immediately


# ── client.init() flows ───────────────────────────────────────────────


def test_init_with_dsn_creates_remote_transport() -> None:
    _client_module._reset_for_testing()
    inariwatch_capture.init(dsn="http://localhost:65535/ingest", silent=True, auto_monitoring=False)
    from inariwatch_capture.transport import RemoteTransport

    assert isinstance(_client_module._transport, RemoteTransport)
    _client_module._transport.close()  # type: ignore[attr-defined]


def test_init_reads_env_var() -> None:
    _client_module._reset_for_testing()
    os.environ["INARIWATCH_DSN"] = "http://localhost:65535/ingest"
    try:
        inariwatch_capture.init(silent=True, auto_monitoring=False)
        assert _client_module._config is not None
        assert _client_module._config["dsn"] == "http://localhost:65535/ingest"
    finally:
        os.environ.pop("INARIWATCH_DSN", None)
        if hasattr(_client_module._transport, "close"):
            _client_module._transport.close()  # type: ignore[attr-defined]


def test_init_with_release_reports_deploy(monkeypatch: pytest.MonkeyPatch) -> None:
    _client_module._reset_for_testing()
    events: list[Any] = []

    class Cap:
        def send(self, e: Any) -> None:
            events.append(dict(e))

        def flush(self, timeout: float = 5.0) -> None:  # noqa: ARG002
            pass

    # Pre-populate transport to capture the deploy marker.
    monkeypatch.setattr(_client_module, "_transport", Cap())
    _client_module._config = {
        "dsn": None,
        "environment": "prod",
        "release": None,
        "debug": False,
        "silent": True,
        "before_send": None,
        "auto_monitoring": False,
        "project_id": None,
    }

    _client_module._report_deploy("v1.2.3", "prod")
    assert any(e.get("eventType") == "deploy" for e in events)
    assert events[0]["title"] == "Deploy: v1.2.3"


def test_flush_global() -> None:
    _client_module._reset_for_testing()
    inariwatch_capture.init(dsn=None, silent=True, auto_monitoring=False)
    inariwatch_capture.flush(timeout=0.1)  # no-op with local transport


# ── Logging handler variants ──────────────────────────────────────────


def test_logging_handler_send_as_log(monkeypatch: pytest.MonkeyPatch) -> None:
    inariwatch_capture.init(dsn=None, silent=True, auto_monitoring=False)
    events: list[Any] = []

    class Cap:
        def send(self, e: Any) -> None:
            events.append(dict(e))

        def flush(self, timeout: float = 5.0) -> None:  # noqa: ARG002
            pass

    monkeypatch.setattr(_client_module, "_transport", Cap())

    logger = logging.getLogger("iw.additional")
    logger.handlers.clear()
    logger.addHandler(InariWatchHandler(level=logging.DEBUG, send_as_log=True))
    logger.propagate = False

    logger.error("something went sideways")
    logger.handlers.clear()

    assert any(e.get("eventType") == "log" for e in events)


def test_logging_handler_message_without_exc_info(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inariwatch_capture.init(dsn=None, silent=True, auto_monitoring=False)
    events: list[Any] = []

    class Cap:
        def send(self, e: Any) -> None:
            events.append(dict(e))

        def flush(self, timeout: float = 5.0) -> None:  # noqa: ARG002
            pass

    monkeypatch.setattr(_client_module, "_transport", Cap())

    logger = logging.getLogger("iw.additional.plain")
    logger.handlers.clear()
    logger.addHandler(InariWatchHandler(level=logging.WARNING))
    logger.propagate = False

    logger.warning("just a warning")
    logger.handlers.clear()

    assert any(e.get("title") == "just a warning" for e in events)


# ── Environment introspection ─────────────────────────────────────────


def test_environment_context_shape() -> None:
    env = get_environment_context()
    # On any supported platform we expect these fields. If memory calls
    # fail they default to 0 — still valid.
    assert env is not None
    for key in (
        "node",
        "platform",
        "arch",
        "cpuCount",
        "totalMemoryMB",
        "freeMemoryMB",
        "heapUsedMB",
        "heapTotalMB",
        "uptime",
    ):
        assert key in env


# ── Git context ───────────────────────────────────────────────────────


def test_git_context_from_env_var() -> None:
    _reset_cache_for_testing()
    os.environ["INARIWATCH_GIT_COMMIT"] = "abc123"
    os.environ["INARIWATCH_GIT_BRANCH"] = "main"
    os.environ["INARIWATCH_GIT_MESSAGE"] = "deploy"
    os.environ["INARIWATCH_GIT_TIMESTAMP"] = "2026-04-24T00:00:00Z"
    os.environ["INARIWATCH_GIT_DIRTY"] = "true"
    try:
        ctx = get_git_context()
        assert ctx == {
            "commit": "abc123",
            "branch": "main",
            "message": "deploy",
            "timestamp": "2026-04-24T00:00:00Z",
            "dirty": True,
        }
    finally:
        for k in (
            "INARIWATCH_GIT_COMMIT",
            "INARIWATCH_GIT_BRANCH",
            "INARIWATCH_GIT_MESSAGE",
            "INARIWATCH_GIT_TIMESTAMP",
            "INARIWATCH_GIT_DIRTY",
        ):
            os.environ.pop(k, None)
        _reset_cache_for_testing()


def test_git_context_subprocess_fallback_caches_miss() -> None:
    _reset_cache_for_testing()
    # Force subprocess fallback by clearing env vars and run get twice.
    # Even if we're inside a git repo, the second call should use the
    # cache without spawning subprocess.
    with patch("inariwatch_capture.git._run_git", return_value=""):
        first = get_git_context()
        second = get_git_context()
    assert first is None
    assert second is None
    _reset_cache_for_testing()


def test_extract_git_info_empty_when_no_git() -> None:
    with patch("inariwatch_capture.git._run_git", return_value=""):
        result = extract_git_info()
    assert result == {}


# ── Breadcrumbs init + URL scrub edge cases ───────────────────────────


def test_init_breadcrumbs_is_idempotent() -> None:
    _b._reset_for_testing()
    root = logging.getLogger()
    before = len(root.handlers)
    _b.init_breadcrumbs(intercept_logging=True)
    _b.init_breadcrumbs(intercept_logging=True)  # second call no-op
    after = len(root.handlers)
    # One handler added, not two.
    assert after - before == 1
    _b._reset_for_testing()


def test_scrub_url_handles_malformed_input() -> None:
    # Obviously-broken string should not raise.
    assert isinstance(_b.scrub_url("not://a real/url??token=xxx"), str)


# ── Transport parse edge cases ────────────────────────────────────────


def test_parse_dsn_with_path_not_capture_prefix() -> None:
    parsed = parse_dsn("https://secret@host.example/other/path")
    # Path is passed through untouched when it doesn't start with /capture/.
    assert parsed["endpoint"].endswith("/other/path")
    assert parsed["secret_key"] == "secret"


def test_sign_payload_empty_body() -> None:
    sig = sign_payload(b"", "secret")
    assert sig.startswith("sha256=")
    assert len(sig) == len("sha256=") + 64
