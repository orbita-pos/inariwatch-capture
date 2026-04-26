"""Top-level API — ``init``, ``capture_exception``, ``capture_message``,
``capture_log``, and ``flush``.

This module owns the module-level transport and config singletons. Keep
it small on purpose: any logic that would make this file balloon (DSN
parsing, fingerprinting, redaction, monitoring) lives in its own module.

The shape of every enriched event matches ``ErrorEvent`` in the Node
SDK so ``web/lib/webhooks`` can process Python events with zero
branching.
"""

from __future__ import annotations

import os
import sys
import traceback
from datetime import datetime, timezone
from typing import Any

from .breadcrumbs import get_breadcrumbs, init_breadcrumbs
from .environment import get_environment_context
from .fingerprint import compute_error_fingerprint
from .git import get_git_context
from .monitoring import (
    FrameLocals,
    get_frame_locals_for,
    register_monitoring,
)
from .scope import get_request_context, get_tags, get_user
from .transport import (
    LocalTransport,
    Transport,
    create_local_transport,
    create_transport,
    parse_dsn,
)
from .types import CaptureConfig, ErrorEvent, LogLevel, Severity

_transport: Transport | None = None
_config: CaptureConfig | None = None
_last_reported_release: str | None = None

_LOG_SEVERITY_MAP: dict[LogLevel, Severity] = {
    "debug": "info",
    "info": "info",
    "warn": "warning",
    "error": "critical",
    "fatal": "critical",
}


def _now_iso() -> str:
    """ISO 8601 with ``Z`` suffix — matches ``new Date().toISOString()``."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _resolve_env(key: str, *fallbacks: str) -> str | None:
    for name in (key, *fallbacks):
        value = os.environ.get(name)
        if value:
            return value
    return None


def init(
    *,
    dsn: str | None = None,
    environment: str | None = None,
    release: str | None = None,
    debug: bool = False,
    silent: bool = False,
    before_send: Any = None,
    auto_monitoring: bool = True,
    project_id: str | None = None,
) -> None:
    """Initialize the SDK. Idempotent — calling twice reuses the config.

    ``dsn`` falls back to ``INARIWATCH_DSN``. Without a DSN the SDK
    enters "local mode" and pretty-prints events to stderr, matching
    the Node ``npx @inariwatch/capture`` first-run flow.
    """
    global _transport, _config, _last_reported_release

    effective_dsn = dsn or _resolve_env("INARIWATCH_DSN")
    effective_env = environment or _resolve_env(
        "INARIWATCH_ENVIRONMENT", "PYTHON_ENV", "APP_ENV"
    )
    effective_release = release or _resolve_env("INARIWATCH_RELEASE")

    cfg: CaptureConfig = {
        "dsn": effective_dsn,
        "environment": effective_env,
        "release": effective_release,
        "debug": debug,
        "silent": silent,
        "before_send": before_send,
        "auto_monitoring": auto_monitoring,
        "project_id": project_id,
    }
    _config = cfg

    if effective_dsn:
        parsed = parse_dsn(effective_dsn)
        if parsed["endpoint"]:
            _transport = create_transport(cfg, parsed)
        else:
            _transport = create_local_transport(cfg)
    else:
        _transport = create_local_transport(cfg)
        if not silent:
            sys.stderr.write(
                "\x1b[2m[inariwatch-capture] Local mode — errors print to "
                "stderr. Set INARIWATCH_DSN to send to cloud.\x1b[0m\n"
            )

    init_breadcrumbs()

    if auto_monitoring:
        register_monitoring(silent=silent)

    if effective_release and effective_release != _last_reported_release:
        _last_reported_release = effective_release
        _report_deploy(effective_release, effective_env)


def _report_deploy(release: str, environment: str | None) -> None:
    if _transport is None or _config is None:
        return
    fingerprint = compute_error_fingerprint(f"deploy:{release}", environment or "")
    event: ErrorEvent = {
        "fingerprint": fingerprint,
        "title": f"Deploy: {release}",
        "body": (
            f"New release deployed: {release}"
            + (f" ({environment})" if environment else "")
        ),
        "severity": "info",
        "timestamp": _now_iso(),
        "environment": environment,
        "release": release,
        "eventType": "deploy",
        "runtime": "python",
    }
    _transport.send(event)


def _format_traceback(err: BaseException) -> str:
    """Match Node's ``error.stack`` shape: first line is ``Name: message``,
    rest is the traceback."""
    tb_lines = traceback.format_exception(type(err), err, err.__traceback__)
    return "".join(tb_lines).rstrip()


def _forensic_payload(err: BaseException) -> dict[str, Any] | None:
    """Build the forensics block from PEP 669 captures + traceback walk.

    Returns ``None`` when we have neither, so the field is simply
    omitted rather than emitted as an empty object (keeps payloads
    compact on simple errors).
    """
    pep669_frames = get_frame_locals_for(err)
    tb_frames = _walk_traceback(err)
    if not pep669_frames and not tb_frames:
        return None

    return {
        "source": "python-pep669" if pep669_frames else "python-traceback",
        "frames": pep669_frames or tb_frames,
    }


def _walk_traceback(err: BaseException) -> list[FrameLocals]:
    """Fallback when PEP 669 didn't fire (e.g. user disabled monitoring).

    Redaction mirrors :mod:`.monitoring` — same patterns, same output
    shape — so downstream tooling sees a single forensics format.
    """
    from .monitoring import _redact_frame_locals

    frames: list[FrameLocals] = []
    tb = err.__traceback__
    while tb is not None:
        frame = tb.tb_frame
        frames.append(
            {
                "file": frame.f_code.co_filename,
                "line": tb.tb_lineno,
                "function": frame.f_code.co_name,
                "locals": _redact_frame_locals(frame.f_locals),
            }
        )
        tb = tb.tb_next
    return frames


def _enrich(event: ErrorEvent) -> ErrorEvent:
    """Attach git + environment + breadcrumbs + scope fields.

    Pure function — callers receive a new dict and the input ``event``
    is untouched. Matches ``enrichEvent`` in the Node client.
    """
    enriched: ErrorEvent = dict(event)  # type: ignore[assignment]

    git_ctx = get_git_context()
    if git_ctx is not None:
        enriched["git"] = git_ctx

    env_ctx = get_environment_context()
    if env_ctx is not None:
        enriched["env"] = env_ctx

    crumbs = get_breadcrumbs()
    if crumbs:
        enriched["breadcrumbs"] = crumbs

    user = get_user()
    if user:
        enriched["user"] = user

    tags = get_tags()
    if tags:
        enriched["tags"] = tags

    req = get_request_context()
    if req is not None:
        enriched["request"] = req

    enriched.setdefault("runtime", "python")
    return enriched


def _dispatch(event: ErrorEvent) -> None:
    if _transport is None or _config is None:
        return
    before_send = _config.get("before_send")
    if before_send:
        try:
            filtered = before_send(event)
        except Exception as err:  # before_send must never crash capture
            if _config.get("debug"):
                sys.stderr.write(f"[inariwatch-capture] before_send raised: {err}\n")
            filtered = event
        if filtered is None:
            return
        _transport.send(filtered)
    else:
        _transport.send(event)


# ── Public ──────────────────────────────────────────────────────────────


def capture_exception(
    error: BaseException,
    context: dict[str, Any] | None = None,
) -> None:
    """Send an exception event to the configured DSN.

    Safe to call from ``except`` blocks::

        try:
            risky()
        except Exception as err:
            capture_exception(err)

    Frame locals are pulled from the PEP 669 cache when available, else
    from the traceback itself. Either way the payload's
    ``metadata.forensics.frames`` list uses the same schema.
    """
    if _transport is None or _config is None:
        return

    title = f"{type(error).__name__}: {error}"
    body = _format_traceback(error)
    fingerprint = compute_error_fingerprint(title, body)

    event: ErrorEvent = {
        "fingerprint": fingerprint,
        "title": title,
        "body": body,
        "severity": "critical",
        "timestamp": _now_iso(),
        "environment": _config.get("environment"),
        "release": _config.get("release"),
        "eventType": "error",
    }

    if context:
        event["context"] = dict(context)
        if "request" in context and isinstance(context["request"], dict):
            event["request"] = context["request"]  # type: ignore[typeddict-item]
        if isinstance(context.get("runtime"), str):
            event["runtime"] = context["runtime"]  # type: ignore[typeddict-item]
        if isinstance(context.get("routePath"), str):
            event["routePath"] = context["routePath"]
        if isinstance(context.get("routeType"), str):
            event["routeType"] = context["routeType"]

    enriched = _enrich(event)

    forensics = _forensic_payload(error)
    if forensics is not None:
        metadata = dict(enriched.get("metadata") or {})
        metadata["forensics"] = forensics
        enriched["metadata"] = metadata

    _dispatch(enriched)


def capture_message(
    message: str,
    level: Severity = "info",
) -> None:
    if _transport is None or _config is None:
        return
    fingerprint = compute_error_fingerprint(message, "")
    event: ErrorEvent = {
        "fingerprint": fingerprint,
        "title": message,
        "body": message,
        "severity": level,
        "timestamp": _now_iso(),
        "environment": _config.get("environment"),
        "release": _config.get("release"),
        "eventType": "error",
    }
    _dispatch(_enrich(event))


def capture_log(
    message: str,
    level: LogLevel = "info",
    metadata: dict[str, Any] | None = None,
) -> None:
    if _transport is None or _config is None:
        return
    severity = _LOG_SEVERITY_MAP.get(level, "info")
    fingerprint = compute_error_fingerprint(f"log:{level}:{message}", "")

    import json as _json

    body = message
    if metadata:
        try:
            body = f"{message}\n\n{_json.dumps(metadata, indent=2, default=str)}"
        except Exception:
            body = message

    event: ErrorEvent = {
        "fingerprint": fingerprint,
        "title": f"[{level.upper()}] {message}",
        "body": body,
        "severity": severity,
        "timestamp": _now_iso(),
        "environment": _config.get("environment"),
        "release": _config.get("release"),
        "eventType": "log",
        "logLevel": level,
        "metadata": dict(metadata) if metadata else None,
    }
    _dispatch(_enrich(event))


def flush(timeout: float = 5.0) -> None:
    """Block until queued events are sent or ``timeout`` seconds pass."""
    if _transport is not None:
        _transport.flush(timeout=timeout)


def _reset_for_testing() -> None:
    """Tear down singletons. For test suites."""
    global _transport, _config, _last_reported_release
    if isinstance(_transport, LocalTransport):
        pass
    elif _transport is not None and hasattr(_transport, "close"):
        _transport.close()  # type: ignore[attr-defined]
    _transport = None
    _config = None
    _last_reported_release = None


__all__ = [
    "capture_exception",
    "capture_log",
    "capture_message",
    "flush",
    "init",
]
