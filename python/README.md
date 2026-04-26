# inariwatch-capture (Python)

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — zero runtime dependencies, Python 3.12+ only.

Payload-compatible with `@inariwatch/capture` on npm. Same DSN, same event schema, same fingerprint algorithm. An error thrown in a FastAPI service produces a byte-identical fingerprint to the same error thrown in a Next.js service, so cross-language deduplication works out of the box.

## Quick start

```bash
pip install inariwatch-capture
```

```python
from inariwatch_capture import init, capture_exception

init(dsn="https://secret@app.inariwatch.com/capture/YOUR_ID")

try:
    risky_operation()
except Exception as err:
    capture_exception(err)
```

Or let it auto-init from environment variables:

```python
import inariwatch_capture.auto  # reads INARIWATCH_DSN, INARIWATCH_RELEASE, etc.
```

## Why Python 3.12+

Python 3.12 stabilized [PEP 669 `sys.monitoring`](https://peps.python.org/pep-0669/), the first low-overhead monitoring API in CPython. We hook `RAISE` and capture frame locals at the throw site with zero overhead on the happy path.

Python 3.11's [PEP 657 fine-grained error locations](https://peps.python.org/pep-0657/) gives us column+end-line info on every frame.

If you need to support Python 3.11 or earlier, use a Sentry-compatible SDK — we do not do the `sys.settrace` fallback dance.

## Zero config

Every error includes automatic context:

| Context | Source |
|---|---|
| **Git commit/branch/message** | env vars (injected at build time) or `git` subprocess fallback |
| **Environment** | `sys.version`, `platform`, memory from `resource` (Unix) or `ctypes` (Windows) |
| **Breadcrumbs** | Auto-intercepts `logging`, `requests.Session.request`, `httpx.Client.send` |
| **Request** | Set via middleware (FastAPI / Flask / Django integrations) or `set_request_context()` |
| **User** | Set via `set_user()` (email stripped by default) |
| **Tags** | Set via `set_tag()` |
| **Frame locals** | Captured on throw via `sys.monitoring` with secret redaction |

Sensitive data is scrubbed automatically: Bearer tokens, JWTs, passwords, API keys, credit card numbers, connection strings, and auth headers are all redacted before leaving your app.

## API

```python
from inariwatch_capture import (
    init,
    capture_exception,
    capture_message,
    capture_log,
    add_breadcrumb,
    set_user,
    set_tag,
    set_request_context,
    run_with_scope,
    flush,
)
```

### `init(**config)`

Initialize the SDK. Call once at app startup.

| Option | Type | Description |
|---|---|---|
| `dsn` | `str \| None` | Capture endpoint. Default: `INARIWATCH_DSN` env var. Omit for local mode. |
| `environment` | `str \| None` | Environment tag. Default: `INARIWATCH_ENVIRONMENT` or `PYTHON_ENV` env var. |
| `release` | `str \| None` | Release version — also triggers a deploy marker. |
| `debug` | `bool` | Log transport errors to stderr. |
| `silent` | `bool` | Suppress all console output. |
| `before_send` | `Callable[[dict], dict \| None]` | Transform or drop events before sending. |
| `auto_monitoring` | `bool` | Enable PEP 669 RAISE handler. Default: `True`. |

### `capture_exception(error, context=None)`

```python
try:
    await risky_operation()
except Exception as err:
    capture_exception(err)
```

### `capture_log(message, level="info", metadata=None)`

```python
capture_log("DB timeout", level="error", metadata={"host": "db.example.com", "latency_ms": 5200})
```

### `capture_message(message, level="info")`

### `add_breadcrumb({"category": ..., "message": ..., "level": ..., "data": ...})`

### `set_user({"id": ..., "role": ...})` — email stripped by default.

### `set_tag(key, value)`

### `set_request_context({"method": ..., "url": ..., "headers": ..., "body": ..., "query": ...})` — secrets redacted.

### `run_with_scope(fn)` — isolate scope per request (contextvars-backed).

### `await flush()` — wait for pending events before process exit.

## Framework integrations

### FastAPI / Starlette

```python
from fastapi import FastAPI
from inariwatch_capture.integrations.fastapi import InariWatchMiddleware

app = FastAPI()
app.add_middleware(InariWatchMiddleware)
```

### Flask

```python
from flask import Flask
from inariwatch_capture.integrations.flask import InariWatchFlask

app = Flask(__name__)
InariWatchFlask(app)
```

### Django

```python
# settings.py
MIDDLEWARE = [
    "inariwatch_capture.integrations.django.InariWatchMiddleware",
    # ...
]
```

### logging

```python
import logging
from inariwatch_capture.integrations.logging import InariWatchHandler

logging.getLogger().addHandler(InariWatchHandler(level=logging.ERROR))
```

## Environment variables

| Variable | Description |
|---|---|
| `INARIWATCH_DSN` | Capture endpoint. Omit for local mode. |
| `INARIWATCH_ENVIRONMENT` | Environment tag (fallback: `PYTHON_ENV`, `APP_ENV`). |
| `INARIWATCH_RELEASE` | Release version. |
| `INARIWATCH_GIT_COMMIT` | Set at build/deploy time to pin git context without a subprocess call. |
| `INARIWATCH_GIT_BRANCH`, `INARIWATCH_GIT_MESSAGE`, `INARIWATCH_GIT_TIMESTAMP`, `INARIWATCH_GIT_DIRTY` | Build-time git context. |

## Cross-SDK conformance

This SDK is byte-compatible with the Node, Rust CLI, and web-side fingerprint implementations. The `tests/test_fingerprint.py` test suite runs against the shared `shared/fingerprint-test-vectors.json` used by the other implementations. If a vector ever diverges, CI fails.

## License

MIT
