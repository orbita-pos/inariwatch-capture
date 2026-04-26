"""Advanced example — before_send filter, custom transport, scope isolation.

Demonstrates the hooks power users reach for:

* ``before_send`` to redact custom fields before events ship.
* ``run_with_scope`` to isolate per-task state in a worker pool.
* ``capture_log`` with structured metadata.
* Manual flush before shutdown.
"""

from __future__ import annotations

import asyncio
from typing import Any

import inariwatch_capture
from inariwatch_capture import run_with_scope, set_tag, set_user


def scrub_custom_fields(event: dict[str, Any]) -> dict[str, Any] | None:
    """Example beforeSend — drop events from the health-check endpoint."""
    request = event.get("request") or {}
    if request.get("url", "").endswith("/healthz"):
        return None  # drop

    # Custom redaction beyond the built-in rules.
    ctx = event.get("context") or {}
    if "internal_id" in ctx:
        ctx = dict(ctx)
        ctx["internal_id"] = "[REDACTED]"
        event["context"] = ctx
    return event


async def process_job(job_id: int, user_id: str) -> None:
    """A worker task. Each invocation gets an isolated scope so tags
    set by one job don't leak into another."""
    with run_with_scope():
        set_user({"id": user_id})
        set_tag("job.id", str(job_id))

        inariwatch_capture.add_breadcrumb(
            {"category": "custom", "message": f"processing job {job_id}"}
        )

        try:
            await _risky_work(job_id)
        except Exception as err:
            inariwatch_capture.capture_exception(
                err,
                context={
                    "internal_id": "will-be-scrubbed-by-before-send",
                    "job_id": job_id,
                },
            )


async def _risky_work(job_id: int) -> None:
    if job_id % 2 == 0:
        raise RuntimeError(f"job {job_id} failed")
    await asyncio.sleep(0.01)


async def main() -> None:
    inariwatch_capture.init(
        environment="production",
        release="v2.1.0",
        before_send=scrub_custom_fields,
    )

    jobs = [(1, "u1"), (2, "u2"), (3, "u3"), (4, "u4")]
    await asyncio.gather(*(process_job(j, u) for j, u in jobs))

    inariwatch_capture.flush(timeout=5.0)


if __name__ == "__main__":
    asyncio.run(main())
