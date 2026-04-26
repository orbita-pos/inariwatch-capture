"""Django integration.

Enable via ``settings.py``::

    MIDDLEWARE = [
        "inariwatch_capture.integrations.django.InariWatchMiddleware",
        # ... your existing middleware ...
    ]

The middleware:

* Opens a fresh scope (``run_with_scope``) around each request.
* Records request context (method, URL, headers) with sensitive headers
  already redacted by :func:`set_request_context`.
* Catches exceptions from the downstream view via
  ``process_exception`` — same place Sentry's Django integration hooks
  in — so we capture before Django renders the 500 page.

Import is intentionally lazy: ``django`` is NOT a core dependency so
users on FastAPI never pay the Django import cost.
"""

from __future__ import annotations

from contextvars import Token
from typing import Any, Callable

from ..client import capture_exception
from ..scope import _scope_var, set_request_context

_TOKEN_ATTR = "_inariwatch_scope_token"


class InariWatchMiddleware:
    """Django middleware — both ``process_exception`` and wrapper style."""

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response

    def __call__(self, request: Any) -> Any:
        token: Token[Any] = _scope_var.set({})
        setattr(request, _TOKEN_ATTR, token)

        try:
            set_request_context(
                method=request.method,
                url=request.build_absolute_uri(),
                headers={k: v for k, v in request.headers.items()} or None,
                query=dict(request.GET) or None,
            )
        except Exception:
            # If request introspection fails (unusual subclass of HttpRequest)
            # we still want the middleware to run rather than return 500.
            pass

        try:
            return self.get_response(request)
        finally:
            token = getattr(request, _TOKEN_ATTR, None)
            if token is not None:
                try:
                    _scope_var.reset(token)
                except (ValueError, LookupError):
                    pass
                setattr(request, _TOKEN_ATTR, None)

    def process_exception(self, request: Any, exception: BaseException) -> None:
        """Django calls this when a view raises. We capture and return
        ``None`` so Django still runs its default 500 handler."""
        capture_exception(exception, context={"runtime": "python"})
        return None


__all__ = ["InariWatchMiddleware"]
