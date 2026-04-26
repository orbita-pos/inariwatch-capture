"""DSN parsing + HMAC-signed HTTP transport + retry buffer.

Mirrors ``capture/src/transport.ts`` at the wire level:

* ``parse_dsn`` accepts the same ``https://secret@host/capture/ID``
  format and applies the same ``/capture/`` -> ``/api/webhooks/capture/``
  rewrite. Localhost DSNs skip HTTPS + HMAC; remote DSNs require HTTPS
  and sign each payload with HMAC-SHA256 using the DSN secret.
* ``createTransport`` is split into two flavours: a ``RemoteTransport``
  that POSTs events with ``x-capture-signature: sha256=<hex>``, and a
  ``LocalTransport`` that prints a pretty line to stderr so
  ``init()`` without a DSN still surfaces errors during local dev.
* The retry buffer is capped at 30 events and dedupes by fingerprint so
  a tight loop can't exhaust memory.

Zero runtime dependencies — only stdlib ``urllib`` + ``hashlib`` +
``hmac`` + ``threading``. The background sender thread is daemonized;
callers that need delivery guarantees use :func:`Transport.flush`.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import queue
import sys
import threading
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING
from urllib.parse import urlsplit, urlunsplit

if TYPE_CHECKING:
    from .types import CaptureConfig, ErrorEvent, ParsedDSN

_MAX_RETRY_BUFFER = 30
_REQUEST_TIMEOUT_S = 10.0


def parse_dsn(dsn: str) -> ParsedDSN:
    """Parse an InariWatch DSN.

    Accepts both:
        - ``http://localhost:9111/ingest`` (local mode, no secret).
        - ``https://SECRET@host/capture/ID`` (cloud mode, HMAC-signed).

    Path rewrites ``/capture/...`` to ``/api/webhooks/capture/...`` to
    match the Next.js route layout.

    Non-local endpoints MUST use HTTPS. A mismatched scheme returns an
    empty endpoint so the caller surfaces a no-op transport.
    """
    parts = urlsplit(dsn)
    hostname = parts.hostname or ""

    if hostname in ("localhost", "127.0.0.1"):
        return {"endpoint": dsn, "secret_key": "", "is_local": True}

    if parts.scheme != "https":
        # Emit a warning but don't crash — caller decides how to handle
        # an empty endpoint (usually falls back to local/no-op).
        sys.stderr.write(
            "[inariwatch-capture] DSN must use HTTPS for non-local endpoints. "
            "Events will not be sent.\n"
        )
        return {"endpoint": "", "secret_key": "", "is_local": False}

    secret_key = parts.username or parts.password or ""
    # Rebuild without the credentials.
    netloc = parts.hostname or ""
    if parts.port:
        netloc = f"{netloc}:{parts.port}"

    path = parts.path
    if path.startswith("/capture/"):
        path = "/api/webhooks" + path

    endpoint = urlunsplit((parts.scheme, netloc, path, parts.query, parts.fragment))
    return {"endpoint": endpoint, "secret_key": secret_key, "is_local": False}


def sign_payload(body: bytes, secret: str) -> str:
    """HMAC-SHA256 signature. Wire format: ``sha256=<hex>``.

    Matches ``sign_payload`` in the Node SDK byte-for-byte so webhooks
    signed here verify cleanly on the ingest side.
    """
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


class Transport(ABC):
    @abstractmethod
    def send(self, event: ErrorEvent) -> None: ...

    @abstractmethod
    def flush(self, timeout: float = 5.0) -> None: ...


class LocalTransport(Transport):
    """Pretty-prints events to stderr.

    Used when no DSN is configured — matches the Node ``createLocalTransport``
    behaviour so ``npx @inariwatch/capture`` and ``pip install
    inariwatch-capture`` have the same first-run experience.
    """

    _SEVERITY_COLORS = {
        "critical": "\x1b[31m",
        "warning": "\x1b[33m",
        "info": "\x1b[36m",
    }

    def send(self, event: ErrorEvent) -> None:
        color = self._SEVERITY_COLORS.get(event.get("severity", "info"), "\x1b[0m")
        reset = "\x1b[0m"
        dim = "\x1b[2m"
        bold = "\x1b[1m"

        # Format timestamp to local HH:MM:SS like Node.
        ts = event.get("timestamp", "")
        try:
            time_part = ts.split("T", 1)[1].split(".", 1)[0] if "T" in ts else ts
        except Exception:
            time_part = ts

        title = event.get("title", "(no title)")
        severity = event.get("severity", "info").upper()
        sys.stderr.write(
            f"\n{dim}{time_part}{reset} {color}{bold}[{severity}]{reset} "
            f"{bold}{title}{reset}\n"
        )

        body = event.get("body") or ""
        if body and body != title:
            lines = body.split("\n")[1:6]
            for line in lines:
                sys.stderr.write(f"{dim}  {line.strip()}{reset}\n")
            if len(body.split("\n")) > 6:
                remaining = len(body.split("\n")) - 6
                sys.stderr.write(f"{dim}  ... ({remaining} more lines){reset}\n")

        context = event.get("context")
        if context:
            try:
                sys.stderr.write(f"{dim}  context: {json.dumps(context)}{reset}\n")
            except (TypeError, ValueError):
                sys.stderr.write(f"{dim}  context: <unserializable>{reset}\n")

    def flush(self, timeout: float = 5.0) -> None:  # noqa: ARG002 - stub
        return None


class RemoteTransport(Transport):
    """HMAC-signed HTTP transport with dedup'd retry buffer.

    Sends happen on a single background daemon thread so caller code
    (often an exception handler) never blocks on network I/O. Failed
    sends land in a 30-slot ring keyed by fingerprint so a tight loop
    doesn't exhaust memory.
    """

    def __init__(self, config: CaptureConfig, parsed: ParsedDSN) -> None:
        self._config = config
        self._endpoint = parsed["endpoint"]
        self._secret = parsed["secret_key"]
        self._is_local = parsed["is_local"]
        self._queue: queue.Queue[ErrorEvent | None] = queue.Queue()
        self._retry_buffer: list[ErrorEvent] = []
        self._retry_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._worker = threading.Thread(
            target=self._run, name="inariwatch-capture-sender", daemon=True
        )
        self._worker.start()

    # ── Private ─────────────────────────────────────────────────────────

    def _log(self, msg: str) -> None:
        if self._config.get("silent"):
            return
        if self._config.get("debug"):
            sys.stderr.write(f"[inariwatch-capture] {msg}\n")

    def _send_one(self, event: ErrorEvent) -> bool:
        try:
            body = json.dumps(event, default=_json_default).encode("utf-8")
        except (TypeError, ValueError) as err:
            self._log(f"serialization error: {err}")
            return True  # drop — retrying won't help

        headers = {"Content-Type": "application/json"}
        if not self._is_local and self._secret:
            headers["x-capture-signature"] = sign_payload(body, self._secret)

        req = urllib.request.Request(
            self._endpoint, data=body, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=_REQUEST_TIMEOUT_S) as resp:
                if 200 <= resp.status < 300:
                    return True
                self._log(f"HTTP {resp.status} from {self._endpoint}")
                return False
        except urllib.error.HTTPError as err:
            # 4xx is a client bug — dropping is correct so a malformed
            # payload doesn't get retried forever.
            if 400 <= err.code < 500:
                self._log(f"HTTP {err.code}: dropping event")
                return True
            self._log(f"HTTP {err.code}: will retry")
            return False
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            self._log(f"transport error: {err}")
            return False

    def _enqueue_retry(self, event: ErrorEvent) -> None:
        fingerprint = event.get("fingerprint", "")
        with self._retry_lock:
            if len(self._retry_buffer) >= _MAX_RETRY_BUFFER:
                return
            if any(e.get("fingerprint") == fingerprint for e in self._retry_buffer):
                return
            self._retry_buffer.append(event)

    def _flush_retries(self) -> None:
        with self._retry_lock:
            batch = self._retry_buffer[:]
            self._retry_buffer.clear()
        remaining: list[ErrorEvent] = []
        for i, event in enumerate(batch):
            if self._stop_event.is_set():
                remaining = batch[i:]
                break
            if not self._send_one(event):
                remaining = batch[i:]
                break
        if remaining:
            with self._retry_lock:
                for event in remaining:
                    if len(self._retry_buffer) < _MAX_RETRY_BUFFER:
                        self._retry_buffer.append(event)

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                item = self._queue.get(timeout=1.0)
            except queue.Empty:
                if self._retry_buffer:
                    self._flush_retries()
                continue
            if item is None:
                self._queue.task_done()
                break
            try:
                if self._send_one(item):
                    self._flush_retries()
                else:
                    self._enqueue_retry(item)
            finally:
                self._queue.task_done()

    # ── Public ──────────────────────────────────────────────────────────

    def send(self, event: ErrorEvent) -> None:
        if not self._endpoint:
            return  # DSN failed validation — silently drop.
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            self._log("queue full, dropping event")

    def flush(self, timeout: float = 5.0) -> None:
        """Block until the queue drains or ``timeout`` seconds elapse."""
        deadline = time.monotonic() + timeout
        # Wait for queue to empty.
        while self._queue.unfinished_tasks > 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        # One more attempt at retries.
        if time.monotonic() < deadline:
            self._flush_retries()

    def close(self) -> None:
        """Stop the sender thread. Only needed in tests."""
        self._stop_event.set()
        self._queue.put_nowait(None)


def _json_default(obj: object) -> object:
    """Fallback serializer for ``json.dumps``.

    Handles bytes, datetimes, and anything exposing ``__str__``. Prevents
    a ``TypeError`` inside the capture path from cascading and losing
    the original error.
    """
    if isinstance(obj, (bytes, bytearray)):
        try:
            return obj.decode("utf-8", errors="replace")
        except Exception:
            return repr(obj)
    if hasattr(obj, "isoformat"):
        try:
            return obj.isoformat()
        except Exception:
            pass
    try:
        return str(obj)
    except Exception:
        return repr(obj)


def create_transport(config: CaptureConfig, parsed: ParsedDSN) -> Transport:
    """Factory — returns a remote transport when a DSN is present."""
    return RemoteTransport(config, parsed)


def create_local_transport(config: CaptureConfig) -> Transport:  # noqa: ARG001
    return LocalTransport()


__all__ = [
    "LocalTransport",
    "RemoteTransport",
    "Transport",
    "create_local_transport",
    "create_transport",
    "parse_dsn",
    "sign_payload",
]
