"""Logging integration — turn ``logger.error`` / ``logger.exception`` calls
into InariWatch events.

Python's ``logging`` module is the canonical place for error reporting
in many apps, so we expose a :class:`logging.Handler` that routes every
``ERROR``-or-higher record through ``capture_message`` (or
``capture_exception`` when ``record.exc_info`` is populated).

Usage::

    import logging
    from inariwatch_capture.integrations.logging import InariWatchHandler

    logging.getLogger().addHandler(InariWatchHandler(level=logging.ERROR))

Distinct from :mod:`inariwatch_capture.breadcrumbs` which attaches a
separate handler that records *all* log lines as breadcrumbs for
context — this module is about turning the log itself into an event.
"""

from __future__ import annotations

import logging

from ..client import capture_exception, capture_log, capture_message

_LEVEL_MAP: dict[int, str] = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "fatal",
}


class InariWatchHandler(logging.Handler):
    """Route log records to InariWatch."""

    def __init__(self, level: int = logging.ERROR, send_as_log: bool = False) -> None:
        """Create the handler.

        ``send_as_log=True`` routes every record through ``capture_log``
        so it shows up under the ``log`` event type in InariWatch.
        Default is ``False`` which routes exceptions through
        ``capture_exception`` (for stack traces) and plain records
        through ``capture_message``.
        """
        super().__init__(level=level)
        self._send_as_log = send_as_log

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._emit(record)
        except Exception:
            # Never let the capture pipeline hide the original log record.
            self.handleError(record)

    def _emit(self, record: logging.LogRecord) -> None:
        message = self.format(record) if self.formatter else record.getMessage()

        if record.exc_info and record.exc_info[1] is not None:
            # ``exc_info = (type, value, tb)``. Pass the value — that's
            # the exception instance capture_exception expects.
            capture_exception(
                record.exc_info[1],
                context={
                    "logger": record.name,
                    "log_level": record.levelname,
                    "message": message,
                },
            )
            return

        if self._send_as_log:
            level = _LEVEL_MAP.get(record.levelno, "info")
            capture_log(message, level=level, metadata={"logger": record.name})  # type: ignore[arg-type]
            return

        severity = "critical" if record.levelno >= logging.ERROR else "warning" if record.levelno >= logging.WARNING else "info"
        capture_message(message, level=severity)  # type: ignore[arg-type]


__all__ = ["InariWatchHandler"]
