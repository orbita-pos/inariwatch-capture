"""Breadcrumb ring buffer + secret scrubbing."""

from __future__ import annotations

from inariwatch_capture.breadcrumbs import (
    _scrub_secrets,  # type: ignore[attr-defined]
    add_breadcrumb,
    clear_breadcrumbs,
    get_breadcrumbs,
    scrub_url,
)


def setup_function() -> None:
    clear_breadcrumbs()


def test_ring_buffer_caps_at_30() -> None:
    for i in range(50):
        add_breadcrumb({"message": f"step {i}"})
    crumbs = get_breadcrumbs()
    assert len(crumbs) == 30
    # Oldest 20 should have been evicted; newest kept.
    assert crumbs[0]["message"] == "step 20"
    assert crumbs[-1]["message"] == "step 49"


def test_bearer_token_scrubbed_in_message() -> None:
    add_breadcrumb({"message": "called API with Authorization: Bearer abc123xyz"})
    msg = get_breadcrumbs()[-1]["message"]
    assert "Bearer abc" not in msg
    assert "[REDACTED]" in msg


def test_jwt_scrubbed() -> None:
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature_thing_abcdefghijklmnop"
    add_breadcrumb({"message": f"token={jwt}"})
    msg = get_breadcrumbs()[-1]["message"]
    assert jwt not in msg


def test_connection_string_scrubbed() -> None:
    url = "postgres://user:hunter2@db.example.com:5432/app"
    assert "hunter2" not in _scrub_secrets(url)


def test_scrub_url_redacts_query_secrets() -> None:
    url = "https://api.example.com/endpoint?token=abc&name=alice&api_key=xxx"
    cleaned = scrub_url(url)
    assert "abc" not in cleaned
    assert "xxx" not in cleaned
    assert "alice" in cleaned


def test_scrub_url_keeps_relative_paths() -> None:
    cleaned = scrub_url("/path?q=hello")
    assert "hello" in cleaned


def test_default_category_is_custom() -> None:
    add_breadcrumb({"message": "hello"})
    assert get_breadcrumbs()[-1]["category"] == "custom"


def test_message_truncated_to_200_chars() -> None:
    add_breadcrumb({"message": "x" * 500})
    msg = get_breadcrumbs()[-1]["message"]
    assert len(msg) <= 200
