"""Intent contracts compiler — Python parts (SKYNET §3 piece 5, Track D).

The Node SDK ships TS, Zod, OpenAPI, Drizzle, Prisma, GraphQL sources.
The Python SDK adds **Pydantic** — the only validator the Python world
actually agrees on.

Public API mirrors the Node side:

>>> from inariwatch_capture.intent import extract_intent_for_frame
>>> contracts = extract_intent_for_frame({"file": "app/api.py", "function": "create_user"})

Each contract is a ``dict`` matching the wire shape:
``{"source": "pydantic", "path": "...#ClassName", "shape": {...}}``
where ``shape`` is the JSON-Schema-flavoured dialect documented in
``capture/src/intent/types.ts``.
"""

from __future__ import annotations

from .types import IntentContract, IntentShape, IntentSource, MAX_SHAPE_BYTES, cap_shape_size
from .pydantic import (
    PydanticSource,
    pydantic_source,
    extract_intent_for_frame,
    DEFAULT_SOURCES,
    reset_cache_for_testing,
    cache_hit_ratio,
)

__all__ = [
    "DEFAULT_SOURCES",
    "IntentContract",
    "IntentShape",
    "IntentSource",
    "MAX_SHAPE_BYTES",
    "PydanticSource",
    "cache_hit_ratio",
    "cap_shape_size",
    "extract_intent_for_frame",
    "pydantic_source",
    "reset_cache_for_testing",
]
