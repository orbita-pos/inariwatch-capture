"""Flask integration.

Usage::

    from flask import Flask
    from inariwatch_capture import init
    from inariwatch_capture.integrations.flask import InariWatchFlask

    init(dsn="...")
    app = Flask(__name__)
    InariWatchFlask(app)

We hook three Flask signals:

* ``before_request`` — open a scope + attach the request context.
* ``got_request_exception`` — capture before Flask's default 500 handler
  runs, so we don't miss exceptions that Flask handles itself.
* ``teardown_request`` — reset the scope token.

The import of ``flask`` is deferred to ``__init__`` so a core install
without Flask is still importable.
"""

from __future__ import annotations

from contextvars import Token
from typing import TYPE_CHECKING, Any

from ..client import capture_exception
from ..scope import _scope_var, set_request_context

if TYPE_CHECKING:
    from flask import Flask


_TOKEN_KEY = "_inariwatch_scope_token"


class InariWatchFlask:
    """Wire InariWatch capture into a Flask application."""

    def __init__(self, app: Flask | None = None) -> None:
        self.app = app
        # Keep strong references to the signal handlers we install so
        # blinker's default weak-ref connect semantics don't GC them
        # as soon as ``init_app`` returns.
        self._on_exception_handler: Any = None
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Flask) -> None:
        import flask

        @app.before_request
        def _before_request() -> None:
            token: Token[Any] = _scope_var.set({})
            flask.g.__dict__[_TOKEN_KEY] = token

            request = flask.request
            # Flask normalizes headers to a case-insensitive multi-dict.
            # We materialize to a plain dict so scope.set_request_context
            # can redact by name.
            headers = {k: v for k, v in request.headers.items()}
            set_request_context(
                method=request.method,
                url=request.url,
                headers=headers or None,
                query=dict(request.args) or None,
                body=_safe_form_body(request),
            )

        @app.teardown_request
        def _teardown_request(_exc: BaseException | None) -> None:
            token = flask.g.__dict__.pop(_TOKEN_KEY, None)
            if token is not None:
                try:
                    _scope_var.reset(token)
                except (ValueError, LookupError):
                    pass

        from flask.signals import got_request_exception

        def _on_exception(sender: Any, exception: BaseException, **_kw: Any) -> None:
            capture_exception(exception, context={"runtime": "python"})

        self._on_exception_handler = _on_exception
        # ``weak=False`` keeps the handler alive even if the caller
        # doesn't hold a reference to this ``InariWatchFlask`` instance.
        got_request_exception.connect(_on_exception, app, weak=False)


def _safe_form_body(request: Any) -> Any:
    """Best-effort body extraction that never crashes.

    We prefer parsed JSON, fall back to form data, then bail to ``None``
    so an unparseable body can't mask the original error.
    """
    try:
        if request.is_json:
            return request.get_json(silent=True)
    except Exception:
        pass
    try:
        if request.form:
            return dict(request.form)
    except Exception:
        pass
    return None


__all__ = ["InariWatchFlask"]
