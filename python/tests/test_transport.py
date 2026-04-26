"""DSN parsing, HMAC signing, retry buffer."""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from inariwatch_capture.transport import (
    RemoteTransport,
    create_transport,
    parse_dsn,
    sign_payload,
)


def test_parse_local_dsn() -> None:
    result = parse_dsn("http://localhost:9111/ingest")
    assert result["is_local"] is True
    assert result["endpoint"] == "http://localhost:9111/ingest"
    assert result["secret_key"] == ""


def test_parse_cloud_dsn_with_secret() -> None:
    dsn = "https://supersecret@app.inariwatch.com/capture/abc123"
    result = parse_dsn(dsn)
    assert result["is_local"] is False
    assert result["secret_key"] == "supersecret"
    # /capture/... rewrites to /api/webhooks/capture/...
    assert result["endpoint"] == "https://app.inariwatch.com/api/webhooks/capture/abc123"


def test_parse_cloud_dsn_requires_https(capsys: pytest.CaptureFixture[str]) -> None:
    result = parse_dsn("http://not-localhost.example/capture/abc")
    # HTTP is refused for non-localhost — endpoint is blanked, not raised
    assert result["endpoint"] == ""
    captured = capsys.readouterr()
    assert "HTTPS" in captured.err


def test_parse_cloud_dsn_strips_credentials() -> None:
    dsn = "https://secret_value@app.inariwatch.com/capture/id"
    result = parse_dsn(dsn)
    assert "secret_value" not in result["endpoint"]
    assert result["secret_key"] == "secret_value"


def test_hmac_signature_matches_reference() -> None:
    body = b'{"fingerprint":"abc","title":"t"}'
    secret = "shared-secret-42"
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert sign_payload(body, secret) == f"sha256={expected}"


def test_hmac_signature_changes_with_body() -> None:
    secret = "abc"
    a = sign_payload(b"payload-one", secret)
    b = sign_payload(b"payload-two", secret)
    assert a != b


# ── Integration: hit a local HTTP server ───────────────────────────────


class _RecordingHandler(BaseHTTPRequestHandler):
    received: list[dict[str, Any]] = []
    signatures: list[str] = []
    fail_next: int = 0

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        sig = self.headers.get("x-capture-signature") or ""
        _RecordingHandler.signatures.append(sig)
        try:
            _RecordingHandler.received.append(json.loads(raw))
        except Exception:
            _RecordingHandler.received.append({"_raw": raw.decode("latin-1")})

        if _RecordingHandler.fail_next > 0:
            _RecordingHandler.fail_next -= 1
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_args: Any) -> None:  # noqa: D401 - silence server logs
        return


@pytest.fixture
def test_server() -> Any:
    _RecordingHandler.received = []
    _RecordingHandler.signatures = []
    _RecordingHandler.fail_next = 0
    server = HTTPServer(("127.0.0.1", 0), _RecordingHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    yield f"http://127.0.0.1:{port}/ingest"
    server.shutdown()
    server.server_close()


def test_remote_transport_sends_event_and_signs(test_server: str) -> None:
    parsed = parse_dsn(test_server)  # local, no HMAC
    transport = create_transport({}, parsed)
    assert isinstance(transport, RemoteTransport)
    transport.send(
        {
            "fingerprint": "fp-1",
            "title": "t",
            "body": "b",
            "severity": "critical",
            "timestamp": "2026-01-01T00:00:00.000Z",
        }
    )
    transport.flush(timeout=3.0)
    transport.close()

    assert len(_RecordingHandler.received) == 1
    event = _RecordingHandler.received[0]
    assert event["fingerprint"] == "fp-1"
    # No signature header for localhost
    assert _RecordingHandler.signatures[0] == ""


def test_remote_transport_retries_then_succeeds(test_server: str) -> None:
    parsed = parse_dsn(test_server)
    transport = create_transport({}, parsed)
    _RecordingHandler.fail_next = 1  # first POST returns 500

    transport.send(
        {
            "fingerprint": "fp-retry",
            "title": "t",
            "body": "b",
            "severity": "info",
            "timestamp": "2026-01-01T00:00:00.000Z",
        }
    )
    transport.flush(timeout=5.0)
    # Retry buffer is drained on next tick; force another pass.
    transport.flush(timeout=2.0)
    transport.close()

    # Server received at least 2 POSTs (1 failed + 1 successful retry).
    assert len(_RecordingHandler.received) >= 2


def test_retry_buffer_dedupes_by_fingerprint(test_server: str) -> None:
    parsed = parse_dsn(test_server)
    transport = create_transport({}, parsed)
    _RecordingHandler.fail_next = 10  # keep failing

    for _ in range(5):
        transport.send(
            {
                "fingerprint": "same",
                "title": "t",
                "body": "b",
                "severity": "info",
                "timestamp": "2026-01-01T00:00:00.000Z",
            }
        )
    transport.flush(timeout=2.0)
    # Retry buffer should have at most 1 entry (dedup) + repeated wire
    # attempts for the same fp counted once.
    with transport._retry_lock:  # type: ignore[attr-defined]
        assert len(transport._retry_buffer) <= 1  # type: ignore[attr-defined]
    transport.close()
