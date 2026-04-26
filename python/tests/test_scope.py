"""Scope isolation, PII stripping, body redaction."""

from __future__ import annotations

import asyncio

from inariwatch_capture.scope import (
    clear_scope,
    get_request_context,
    get_tags,
    get_user,
    run_with_scope,
    set_request_context,
    set_tag,
    set_user,
)


def test_set_user_strips_email() -> None:
    clear_scope()
    set_user({"id": "u1", "email": "user@example.com", "role": "admin"})
    user = get_user()
    assert user == {"id": "u1", "role": "admin"}
    assert "email" not in user  # type: ignore[operator]


def test_set_tag_accumulates() -> None:
    clear_scope()
    set_tag("feature", "checkout")
    set_tag("env", "prod")
    assert get_tags() == {"feature": "checkout", "env": "prod"}


def test_request_context_redacts_auth_header() -> None:
    clear_scope()
    set_request_context(
        method="POST",
        url="/api/x",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer abc",
            "X-API-Key": "secret",
        },
    )
    ctx = get_request_context()
    assert ctx is not None
    headers = ctx["headers"] or {}
    assert headers["Content-Type"] == "application/json"
    assert headers["Authorization"] == "[REDACTED]"
    assert headers["X-API-Key"] == "[REDACTED]"


def test_request_context_redacts_ip_headers() -> None:
    clear_scope()
    set_request_context(
        method="GET",
        url="/",
        headers={"X-Forwarded-For": "1.2.3.4"},
    )
    headers = (get_request_context() or {})["headers"] or {}
    assert headers.get("X-Forwarded-For") == "[REDACTED]"


def test_request_context_redacts_body_fields() -> None:
    clear_scope()
    set_request_context(
        method="POST",
        url="/login",
        body={"username": "alice", "password": "hunter2", "token": "bear"},
    )
    body = (get_request_context() or {}).get("body")
    assert body == {
        "username": "alice",
        "password": "[REDACTED]",
        "token": "[REDACTED]",
    }


def test_request_context_truncates_long_strings_in_body() -> None:
    clear_scope()
    set_request_context(
        method="POST",
        url="/",
        body={"description": "x" * 700},
    )
    body = (get_request_context() or {}).get("body")
    assert body is not None
    assert "truncated" in body["description"]


def test_run_with_scope_isolation() -> None:
    clear_scope()
    set_tag("outer", "1")
    with run_with_scope():
        assert get_tags() is None or "outer" not in (get_tags() or {})
        set_tag("inner", "2")
        assert (get_tags() or {}).get("inner") == "2"
    # Outer scope preserved
    assert (get_tags() or {}).get("outer") == "1"


def test_scope_isolation_across_async_tasks() -> None:
    """contextvars-backed scope survives asyncio hops."""
    clear_scope()

    async def task_a() -> str | None:
        with run_with_scope():
            set_user({"id": "a"})
            await asyncio.sleep(0)
            return (get_user() or {}).get("id")

    async def task_b() -> str | None:
        with run_with_scope():
            set_user({"id": "b"})
            await asyncio.sleep(0)
            return (get_user() or {}).get("id")

    async def main() -> list[str | None]:
        return list(await asyncio.gather(task_a(), task_b()))

    results = asyncio.run(main())
    assert results == ["a", "b"]


def test_pii_not_written_by_default() -> None:
    clear_scope()
    set_request_context(method="GET", url="/x", ip=None)
    ctx = get_request_context() or {}
    assert "ip" not in ctx


def test_ip_recorded_only_when_explicit() -> None:
    clear_scope()
    set_request_context(method="GET", url="/x", ip="9.9.9.9")
    ctx = get_request_context() or {}
    assert ctx.get("ip") == "9.9.9.9"
