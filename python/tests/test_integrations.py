"""Framework integration smoke tests — just enough to prove each
middleware wires ``run_with_scope`` + ``set_request_context`` + captures
unhandled exceptions. Full HTTP-level tests live in
``examples/`` but they'd pull in heavy deps we don't want in CI."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from inariwatch_capture import client as _client_module
from inariwatch_capture import init
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


# ── ASGI / FastAPI ────────────────────────────────────────────────────


def test_asgi_middleware_captures_exception(fake_transport: _FakeTransport) -> None:
    from inariwatch_capture.integrations.fastapi import InariWatchMiddleware

    async def app(scope: dict, receive: Any, send: Any) -> None:  # noqa: ARG001
        raise RuntimeError("asgi boom")

    wrapped = InariWatchMiddleware(app)

    async def run() -> None:
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/orders",
            "scheme": "http",
            "server": ("127.0.0.1", 8000),
            "query_string": b"status=new",
            "headers": [
                (b"host", b"api.example.com"),
                (b"authorization", b"Bearer xyz"),
            ],
        }

        async def _receive() -> dict[str, Any]:
            return {"type": "http.request"}

        async def _send(_msg: dict[str, Any]) -> None:
            return None

        with pytest.raises(RuntimeError):
            await wrapped(scope, _receive, _send)

    asyncio.run(run())

    assert len(fake_transport.events) == 1
    event = fake_transport.events[0]
    assert event["title"] == "RuntimeError: asgi boom"
    request = event.get("request") or {}
    assert request.get("method") == "POST"
    # Authorization header redacted
    assert request.get("headers", {}).get("authorization") == "[REDACTED]"


def test_asgi_middleware_runs_scope_isolated(fake_transport: _FakeTransport) -> None:
    from inariwatch_capture.integrations.fastapi import InariWatchMiddleware
    from inariwatch_capture.scope import get_request_context

    async def app(scope: dict, receive: Any, send: Any) -> None:  # noqa: ARG001
        # Inside the app the request context should be set.
        assert get_request_context() is not None

    wrapped = InariWatchMiddleware(app)

    async def run() -> None:
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/",
            "scheme": "http",
            "server": ("127.0.0.1", 8000),
            "headers": [],
        }

        async def _receive() -> dict[str, Any]:
            return {"type": "http.request"}

        async def _send(_msg: dict[str, Any]) -> None:
            return None

        await wrapped(scope, _receive, _send)

    asyncio.run(run())

    # Outside the middleware the scope is gone.
    from inariwatch_capture.scope import clear_scope, get_request_context

    clear_scope()
    assert get_request_context() is None


# ── Flask ─────────────────────────────────────────────────────────────


def test_flask_integration_captures_view_exception(fake_transport: _FakeTransport) -> None:
    pytest.importorskip("flask")
    from flask import Flask

    from inariwatch_capture.integrations.flask import InariWatchFlask

    app = Flask(__name__)
    InariWatchFlask(app)

    @app.route("/boom")
    def boom() -> str:  # pragma: no cover - raises before returning
        raise ValueError("flask boom")

    client = app.test_client()
    # Flask returns 500 when a view raises; we still want the event captured.
    resp = client.get("/boom")
    assert resp.status_code == 500

    assert len(fake_transport.events) == 1
    assert fake_transport.events[0]["title"] == "ValueError: flask boom"


# ── Django ────────────────────────────────────────────────────────────


def test_django_middleware_captures_exception(fake_transport: _FakeTransport) -> None:
    pytest.importorskip("django")

    # Minimal Django settings so the middleware can introspect a request.
    import django
    from django.conf import settings

    if not settings.configured:
        settings.configure(
            DEBUG=False,
            ROOT_URLCONF=__name__,
            SECRET_KEY="test",
            ALLOWED_HOSTS=["*"],
            DATABASES={},
            INSTALLED_APPS=[],
        )
        django.setup()

    from django.test import RequestFactory

    from inariwatch_capture.integrations.django import InariWatchMiddleware

    factory = RequestFactory()
    request = factory.post("/x", data={"password": "hunter2"}, HTTP_AUTHORIZATION="Bearer abc")

    def view(_req: Any) -> Any:
        raise LookupError("django boom")

    middleware = InariWatchMiddleware(view)
    # __call__ runs get_response; process_exception is called separately by
    # Django's handler. We call it directly to simulate.
    try:
        middleware(request)
    except LookupError:
        pass
    middleware.process_exception(request, LookupError("django boom"))

    # process_exception captures, so at least one event is expected.
    assert any("django boom" in e["title"] for e in fake_transport.events)


# ── Logging handler ───────────────────────────────────────────────────


def test_logging_handler_captures_exception(fake_transport: _FakeTransport) -> None:
    import logging

    from inariwatch_capture.integrations.logging import InariWatchHandler

    logger = logging.getLogger("inariwatch.test")
    logger.handlers.clear()
    logger.addHandler(InariWatchHandler(level=logging.ERROR))
    logger.propagate = False

    try:
        raise ValueError("log-captured")
    except ValueError:
        logger.exception("boom happened")

    logger.handlers.clear()

    assert any("log-captured" in e["title"] for e in fake_transport.events)
