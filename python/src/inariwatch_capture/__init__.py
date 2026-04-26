"""inariwatch-capture — Python SDK for InariWatch.

Public API mirrors ``@inariwatch/capture`` on npm. Identical DSN,
identical event schema, byte-identical fingerprint so dedup works
across Node, Python, Rust, Go, etc.

>>> from inariwatch_capture import init, capture_exception
>>> init(dsn="https://SECRET@app.inariwatch.com/capture/YOUR_ID")
>>> try:
...     risky_operation()
... except Exception as err:
...     capture_exception(err)
"""

from __future__ import annotations

from .breadcrumbs import add_breadcrumb
from .client import (
    capture_exception,
    capture_log,
    capture_message,
    flush,
    init,
)
from .fingerprint import compute_error_fingerprint
from .forensic import (
    ForensicCapture,
    ForensicOptions,
    ForensicValue,
    FrameSnapshot,
    register_forensic_hook,
    unregister_forensic_hook,
)
from .scope import (
    clear_scope,
    run_with_scope,
    set_request_context,
    set_tag,
    set_user,
)
from .types import (
    Breadcrumb,
    CaptureConfig,
    EnvironmentContext,
    ErrorEvent,
    GitContext,
    ParsedDSN,
    RequestContext,
    User,
)

__version__ = "0.1.0"

__all__ = [
    "Breadcrumb",
    "CaptureConfig",
    "EnvironmentContext",
    "ErrorEvent",
    "ForensicCapture",
    "ForensicOptions",
    "ForensicValue",
    "FrameSnapshot",
    "GitContext",
    "ParsedDSN",
    "RequestContext",
    "User",
    "__version__",
    "add_breadcrumb",
    "capture_exception",
    "capture_log",
    "capture_message",
    "clear_scope",
    "compute_error_fingerprint",
    "flush",
    "init",
    "register_forensic_hook",
    "run_with_scope",
    "set_request_context",
    "set_tag",
    "set_user",
    "unregister_forensic_hook",
]
