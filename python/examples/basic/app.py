"""Minimal example — capture an exception and flush.

Run::

    INARIWATCH_DSN=http://localhost:9111/ingest python examples/basic/app.py

Without a DSN the SDK runs in local mode and pretty-prints to stderr.
"""

from __future__ import annotations

import inariwatch_capture


def main() -> None:
    inariwatch_capture.init(
        environment="development",
        release="0.1.0",
    )
    inariwatch_capture.set_user({"id": "u42", "role": "admin"})
    inariwatch_capture.set_tag("feature", "example")

    inariwatch_capture.add_breadcrumb(
        {"category": "custom", "message": "user started the demo"}
    )

    try:
        _do_work("alice", secret_token="will-be-redacted")
    except RuntimeError as err:
        inariwatch_capture.capture_exception(err)

    inariwatch_capture.capture_log(
        "demo finished",
        level="info",
        metadata={"duration_ms": 42},
    )

    inariwatch_capture.flush(timeout=2.0)


def _do_work(name: str, *, secret_token: str) -> None:
    local_var = {"name": name, "token": secret_token}  # token key will be scrubbed
    raise RuntimeError(f"simulated failure for {name}")


if __name__ == "__main__":
    main()
