"""End-to-end behaviour via a fake transport.

These tests avoid touching the network — we swap the module-level
``_transport`` singleton with a recording mock. This mirrors how
``capture/test/`` exercises the Node SDK.
"""

from __future__ import annotations

from typing import Any

import pytest

import inariwatch_capture
from inariwatch_capture import (
    add_breadcrumb,
    capture_exception,
    capture_log,
    capture_message,
    init,
    set_tag,
    set_user,
)
from inariwatch_capture import client as _client_module
from inariwatch_capture.transport import Transport


class _FakeTransport(Transport):
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def send(self, event: Any) -> None:
        self.events.append(dict(event))

    def flush(self, timeout: float = 5.0) -> None:  # noqa: ARG002
        return None


@pytest.fixture
def fake_transport(monkeypatch: pytest.MonkeyPatch) -> _FakeTransport:
    init(dsn=None, silent=True, auto_monitoring=False)
    fake = _FakeTransport()
    monkeypatch.setattr(_client_module, "_transport", fake)
    return fake


def test_capture_exception_populates_payload(fake_transport: _FakeTransport) -> None:
    try:
        raise ValueError("test")
    except ValueError as err:
        capture_exception(err)

    assert len(fake_transport.events) == 1
    event = fake_transport.events[0]
    assert event["title"] == "ValueError: test"
    assert event["severity"] == "critical"
    assert event["eventType"] == "error"
    assert event["runtime"] == "python"
    assert len(event["fingerprint"]) == 64
    assert "Traceback" in event["body"]


def test_capture_exception_includes_scope(fake_transport: _FakeTransport) -> None:
    set_user({"id": "u42", "email": "x@y.com", "role": "admin"})
    set_tag("feature", "checkout")
    add_breadcrumb({"message": "user clicked"})

    try:
        raise RuntimeError("kaboom")
    except RuntimeError as err:
        capture_exception(err)

    event = fake_transport.events[0]
    assert event["user"] == {"id": "u42", "role": "admin"}  # email stripped
    assert event["tags"] == {"feature": "checkout"}
    assert len(event["breadcrumbs"]) >= 1


def test_capture_exception_includes_forensics(fake_transport: _FakeTransport) -> None:
    # Monitoring not registered in fixture — falls back to traceback walk.
    def inner(secret_token: str) -> None:
        raise KeyError("missing")

    try:
        inner("super-secret")
    except KeyError as err:
        capture_exception(err)

    event = fake_transport.events[0]
    forensics = event.get("metadata", {}).get("forensics")
    assert forensics is not None
    assert forensics["frames"]
    # Sensitive local scrubbed even on traceback-walk path.
    assert all(
        f["locals"].get("secret_token", "") in (None, "[REDACTED]")
        or f["function"] != "inner"
        for f in forensics["frames"]
    )


def test_capture_message(fake_transport: _FakeTransport) -> None:
    capture_message("something happened", level="warning")
    event = fake_transport.events[0]
    assert event["title"] == "something happened"
    assert event["severity"] == "warning"


def test_capture_log_renders_metadata(fake_transport: _FakeTransport) -> None:
    capture_log("DB timeout", level="error", metadata={"host": "db", "latency_ms": 5200})
    event = fake_transport.events[0]
    assert event["logLevel"] == "error"
    assert event["severity"] == "critical"
    assert "db" in event["body"]
    assert event["metadata"] == {"host": "db", "latency_ms": 5200}


def test_before_send_can_drop_event(monkeypatch: pytest.MonkeyPatch) -> None:
    init(
        dsn=None,
        silent=True,
        auto_monitoring=False,
        before_send=lambda _ev: None,
    )
    fake = _FakeTransport()
    monkeypatch.setattr(_client_module, "_transport", fake)

    capture_message("should be dropped")
    assert fake.events == []


def test_before_send_can_transform_event(monkeypatch: pytest.MonkeyPatch) -> None:
    def scrub(event: Any) -> Any:
        event["title"] = "[scrubbed]"
        return event

    init(dsn=None, silent=True, auto_monitoring=False, before_send=scrub)
    fake = _FakeTransport()
    monkeypatch.setattr(_client_module, "_transport", fake)

    capture_message("original")
    assert fake.events[0]["title"] == "[scrubbed]"


def test_captures_use_python_runtime_tag(fake_transport: _FakeTransport) -> None:
    capture_message("x")
    assert fake_transport.events[0]["runtime"] == "python"


def test_fingerprint_stable_across_calls(fake_transport: _FakeTransport) -> None:
    for _ in range(3):
        try:
            raise TypeError("same error")
        except TypeError as err:
            capture_exception(err)

    fps = {e["fingerprint"] for e in fake_transport.events}
    assert len(fps) == 1  # identical normalized title+stack => same fp


def test_version_exported() -> None:
    assert isinstance(inariwatch_capture.__version__, str)
