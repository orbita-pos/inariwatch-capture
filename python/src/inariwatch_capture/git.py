"""Git context — read from env vars at runtime, populated by the build step.

The Node SDK is wrapped by framework plugins (``withInariWatch``) that
run ``git`` at build time and write the result into ``INARIWATCH_GIT_*``
env vars. Python deployments don't have that sugar yet, so we also
support a lazy subprocess fallback when the env vars are missing and
we're running inside a git work tree. The subprocess call happens AT
MOST ONCE per process — the result is cached in memory regardless of
outcome.
"""

from __future__ import annotations

import os
import re
import subprocess
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .types import GitContext

_cached: dict[str, str] | None = None
_cache_loaded = False

# Matches the commit-message scrubbing in capture/src/git.ts.
_MESSAGE_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"(?:sk|pk|api|key|token|secret|password)[_-]?\S{8,}", re.IGNORECASE),
        "[REDACTED]",
    ),
    (re.compile(r"://[^:]+:[^@]+@"), "://[REDACTED]@"),
)


def _scrub_commit_message(message: str) -> str:
    out = message
    for pattern, replacement in _MESSAGE_SECRET_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def _run_git(*args: str) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            check=False,
            timeout=2.0,
            text=True,
        )
        if result.returncode != 0:
            return ""
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return ""


def _load_from_env() -> dict[str, str] | None:
    commit = os.environ.get("INARIWATCH_GIT_COMMIT")
    if not commit:
        return None
    return {
        "commit": commit,
        "branch": os.environ.get("INARIWATCH_GIT_BRANCH", "unknown"),
        "message": os.environ.get("INARIWATCH_GIT_MESSAGE", ""),
        "timestamp": os.environ.get("INARIWATCH_GIT_TIMESTAMP", ""),
        "dirty": os.environ.get("INARIWATCH_GIT_DIRTY", "false"),
    }


def _load_from_subprocess() -> dict[str, str] | None:
    commit = _run_git("rev-parse", "HEAD")
    if not commit:
        return None
    branch = _run_git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    message = _scrub_commit_message(_run_git("log", "-1", "--format=%s"))[:200]
    timestamp = _run_git("log", "-1", "--format=%cI")
    dirty = "true" if _run_git("status", "--porcelain") else "false"
    return {
        "commit": commit,
        "branch": branch,
        "message": message,
        "timestamp": timestamp,
        "dirty": dirty,
    }


def get_git_context() -> GitContext | None:
    """Return git context for the current deployment, or ``None``.

    Resolution order:
        1. ``INARIWATCH_GIT_COMMIT`` env var (fast path — set at build).
        2. ``git rev-parse`` subprocess (slow path — runs once, cached).
        3. ``None``.
    """
    global _cached, _cache_loaded

    if _cache_loaded:
        if _cached is None:
            return None
        return _as_context(_cached)

    raw = _load_from_env() or _load_from_subprocess()
    _cached = raw
    _cache_loaded = True
    if raw is None:
        return None
    return _as_context(raw)


def _as_context(raw: dict[str, str]) -> GitContext:
    return {
        "commit": raw["commit"],
        "branch": raw["branch"],
        "message": raw.get("message", ""),
        "timestamp": raw.get("timestamp", ""),
        "dirty": raw.get("dirty", "false") == "true",
    }


def extract_git_info() -> dict[str, str]:
    """Build-time helper — return a mapping suitable for ``os.environ.update``.

    Use this in deploy scripts before starting the process::

        from inariwatch_capture.git import extract_git_info
        os.environ.update(extract_git_info())
    """
    commit = _run_git("rev-parse", "HEAD")
    if not commit:
        return {}
    branch = _run_git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"
    message = _scrub_commit_message(_run_git("log", "-1", "--format=%s"))[:200]
    timestamp = _run_git("log", "-1", "--format=%cI")
    dirty = "true" if _run_git("status", "--porcelain") else "false"
    return {
        "INARIWATCH_GIT_COMMIT": commit,
        "INARIWATCH_GIT_BRANCH": branch,
        "INARIWATCH_GIT_MESSAGE": message,
        "INARIWATCH_GIT_TIMESTAMP": timestamp,
        "INARIWATCH_GIT_DIRTY": dirty,
    }


def _reset_cache_for_testing() -> None:
    global _cached, _cache_loaded
    _cached = None
    _cache_loaded = False


__all__ = ["extract_git_info", "get_git_context"]
