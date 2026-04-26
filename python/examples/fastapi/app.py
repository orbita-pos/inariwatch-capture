"""FastAPI example — install the ASGI middleware and serve two routes.

Run::

    pip install fastapi uvicorn
    uvicorn examples.fastapi.app:app --reload

Then ``GET /hello`` succeeds and ``GET /boom`` raises a handled 500 that
gets shipped to InariWatch along with the full request context.
"""

from __future__ import annotations

from fastapi import FastAPI

import inariwatch_capture
from inariwatch_capture.integrations.fastapi import InariWatchMiddleware

inariwatch_capture.init(environment="development", release="example")

app = FastAPI(title="InariWatch FastAPI example")
app.add_middleware(InariWatchMiddleware)


@app.get("/hello")
def hello() -> dict[str, str]:
    return {"message": "ok"}


@app.get("/boom")
def boom() -> dict[str, str]:
    # Local variables are captured + redacted by PEP 669 on throw.
    session_token = "will-be-redacted"  # noqa: F841
    query_params = {"password": "deep-redact"}  # noqa: F841
    raise ValueError("simulated failure")


@app.post("/login")
def login(payload: dict) -> dict[str, str]:
    # Sensitive body fields are scrubbed before the request context is
    # attached to any event.
    inariwatch_capture.capture_log(
        "login attempt", level="info", metadata={"user_id": payload.get("user_id")}
    )
    return {"status": "ok"}
