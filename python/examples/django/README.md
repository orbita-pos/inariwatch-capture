# Django example

Add the middleware to your existing Django project:

```python
# settings.py
MIDDLEWARE = [
    "inariwatch_capture.integrations.django.InariWatchMiddleware",
    # ... the rest of your middleware ...
]
```

Then call `init()` once at startup:

```python
# settings.py (bottom of file) or manage.py
import inariwatch_capture

inariwatch_capture.init(
    environment=os.getenv("DJANGO_ENV", "development"),
    release=os.getenv("RELEASE"),
)
```

The middleware:

- Opens a per-request scope so `set_user` / `set_tag` / `set_request_context`
  stay isolated per request.
- Captures unhandled view exceptions via `process_exception` (Django's
  standard hook).
- Redacts sensitive headers (Authorization, Cookie, X-API-Key, ...)
  automatically.
- Skips IP collection unless you explicitly pass `ip=...` to
  `set_request_context`.
