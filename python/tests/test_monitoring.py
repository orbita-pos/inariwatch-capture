"""PEP 669 RAISE hook + frame-local redaction."""

from __future__ import annotations

import pytest

from inariwatch_capture.monitoring import (
    _safe_repr,  # type: ignore[attr-defined]
    _should_redact_name,  # type: ignore[attr-defined]
    get_frame_locals_for,
    register_monitoring,
    unregister_monitoring,
)


@pytest.fixture(autouse=True)
def _cycle_monitoring() -> None:
    """Each test gets a fresh PEP 669 registration."""
    unregister_monitoring()
    yield
    unregister_monitoring()


def test_should_redact_name_positive_cases() -> None:
    for name in [
        "password",
        "user_password",
        "API_KEY",
        "session_token",
        "stripe_secret",
        "cookie_jar",
        "ssn",
        "credit_card_number",
    ]:
        assert _should_redact_name(name), f"{name!r} should be redacted"


def test_should_redact_name_negative_cases() -> None:
    for name in ["id", "name", "email", "count", "url"]:
        assert not _should_redact_name(name)


def test_safe_repr_redacts_sensitive_dict_keys() -> None:
    out = _safe_repr({"name": "alice", "password": "hunter2", "nested": {"api_key": "xxx"}})
    assert "hunter2" not in out
    assert "xxx" not in out
    assert "alice" in out


def test_safe_repr_bounded_length() -> None:
    out = _safe_repr("x" * 1000)
    assert len(out) <= 220  # 200 + truncation marker
    assert "truncated" in out


def test_safe_repr_never_raises() -> None:
    class Explode:
        def __repr__(self) -> str:
            raise RuntimeError("nope")

    out = _safe_repr(Explode())
    assert "unreprable" in out


def test_pep669_captures_frame_locals() -> None:
    assert register_monitoring(silent=True) is True

    def inner(order_id: int) -> None:
        local_x = "value"  # noqa: F841
        raise ValueError("boom")

    try:
        inner(42)
    except ValueError as err:
        frames = get_frame_locals_for(err)

    assert len(frames) >= 1
    first = frames[0]
    assert first["function"] == "inner"
    assert first["locals"]["order_id"] == "42"
    assert first["locals"]["local_x"] == "'value'"


def test_pep669_redacts_sensitive_local_names() -> None:
    assert register_monitoring(silent=True) is True

    def login(user_password: str, session_token: str) -> None:
        raise RuntimeError("oops")

    try:
        login("hunter2", "secret-session-id-9xx")
    except RuntimeError as err:
        frames = get_frame_locals_for(err)

    assert frames
    locals_dict = frames[0]["locals"]
    assert locals_dict["user_password"] == "[REDACTED]"
    assert locals_dict["session_token"] == "[REDACTED]"


def test_pep669_redacts_nested_secrets() -> None:
    assert register_monitoring(silent=True) is True

    def handler(payload: dict) -> None:
        raise KeyError("boom")

    try:
        handler({"user_id": 42, "api_key": "abcxyz12345", "nested": {"password": "pw"}})
    except KeyError as err:
        frames = get_frame_locals_for(err)

    payload_repr = frames[0]["locals"]["payload"]
    assert "abcxyz12345" not in payload_repr
    assert "[REDACTED]" in payload_repr
    assert "user_id" in payload_repr  # non-sensitive field kept


def test_register_is_idempotent() -> None:
    assert register_monitoring(silent=True) is True
    # Second call should also succeed (idempotent).
    assert register_monitoring(silent=True) is True


def test_unregister_stops_capture() -> None:
    register_monitoring(silent=True)
    unregister_monitoring()

    def f() -> None:
        raise ValueError("unwatched")

    try:
        f()
    except ValueError as err:
        assert get_frame_locals_for(err) == []
