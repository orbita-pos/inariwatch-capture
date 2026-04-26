"""Event and config shapes — mirror capture/src/types.ts byte-for-byte at the JSON level.

We use ``TypedDict`` (not dataclasses) because the wire format is
``dict[str, Any]`` and ``typing.TypedDict`` lets callers pass plain dicts
without a conversion step. Every field name matches the Node SDK so a
single payload dict round-trips between SDKs identically.
"""

from __future__ import annotations

from typing import Any, Callable, Literal, NotRequired, TypedDict

Severity = Literal["critical", "warning", "info"]
LogLevel = Literal["debug", "info", "warn", "error", "fatal"]
BreadcrumbLevel = Literal["debug", "info", "warning", "error"]
BreadcrumbCategory = Literal["console", "fetch", "navigation", "custom", "log", "http"]
Runtime = Literal["python", "nodejs", "edge", "go", "rust", "jvm", "dotnet", "browser"]
EventType = Literal["error", "log", "deploy", "security"]


class Breadcrumb(TypedDict):
    timestamp: str
    category: BreadcrumbCategory
    message: str
    level: BreadcrumbLevel
    data: NotRequired[dict[str, Any] | None]


class GitContext(TypedDict):
    commit: str
    branch: str
    message: str
    timestamp: str
    dirty: bool


class EnvironmentContext(TypedDict):
    """Node's ``EnvironmentContext`` uses Node-specific field names (``node``,
    ``heapUsedMB``). We keep those names so payloads stay identical on the
    wire — the backend does not look at them per language."""

    node: str  # For Python, this is the interpreter version string ("3.12.3").
    platform: str
    arch: str
    cpuCount: int
    totalMemoryMB: int
    freeMemoryMB: int
    heapUsedMB: int
    heapTotalMB: int
    uptime: int


class RequestContext(TypedDict, total=False):
    method: str
    url: str
    headers: dict[str, str] | None
    query: dict[str, str] | None
    body: Any
    ip: str | None


class User(TypedDict, total=False):
    id: str
    role: str


class ErrorEvent(TypedDict, total=False):
    fingerprint: str
    title: str
    body: str
    severity: Severity
    timestamp: str
    environment: str | None
    release: str | None
    context: dict[str, Any] | None
    request: RequestContext | None
    runtime: Runtime
    routePath: str | None
    routeType: str | None
    eventType: EventType
    logLevel: LogLevel
    metadata: dict[str, Any] | None
    git: GitContext | None
    breadcrumbs: list[Breadcrumb] | None
    env: EnvironmentContext | None
    user: User | None
    tags: dict[str, str] | None
    # Python-specific forensics (PEP 669 / PEP 657) go in metadata.forensics
    # to stay wire-compatible with the generic ingest.


class ParsedDSN(TypedDict):
    endpoint: str
    secret_key: str
    is_local: bool


BeforeSendHook = Callable[[ErrorEvent], "ErrorEvent | None"]


class CaptureConfig(TypedDict, total=False):
    dsn: str | None
    environment: str | None
    release: str | None
    debug: bool
    silent: bool
    before_send: BeforeSendHook | None
    auto_monitoring: bool
    project_id: str | None


__all__ = [
    "Breadcrumb",
    "BreadcrumbCategory",
    "BreadcrumbLevel",
    "CaptureConfig",
    "BeforeSendHook",
    "EnvironmentContext",
    "ErrorEvent",
    "EventType",
    "GitContext",
    "LogLevel",
    "ParsedDSN",
    "RequestContext",
    "Runtime",
    "Severity",
    "User",
]
