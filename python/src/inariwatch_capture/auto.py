"""Auto-initializing import — just import this module and capture starts.

Usage::

    import inariwatch_capture.auto  # noqa: F401

Or via an entry-point::

    python -X importtime -m inariwatch_capture.auto app.py  # illustrative

Reads config from environment variables (matches Node SDK):

    INARIWATCH_DSN          - capture endpoint (omit for local mode)
    INARIWATCH_ENVIRONMENT  - environment tag (fallback: PYTHON_ENV, APP_ENV)
    INARIWATCH_RELEASE      - release version
"""

from __future__ import annotations

from .client import init

init()
