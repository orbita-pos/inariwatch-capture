"""Intent contracts — shared types (Python port).

Mirrors ``capture/src/intent/types.ts``. ``IntentShape`` is a JSON-Schema-
flavoured ``dict`` (intentionally not a TypedDict — different sources emit
different subsets, and locking the spec would force conversions
downstream). The shape is opaque to the wire payload anyway: the LLM reads
it as JSON.
"""

from __future__ import annotations

import json
from typing import Any, Protocol, runtime_checkable

# Hard cap on serialized shape size — anything past this is truncated. Mirror
# of the Node constant so the polyglot SDKs all agree on the wire budget.
MAX_SHAPE_BYTES = 10 * 1024


IntentShape = dict[str, Any]
"""JSON-Schema-flavoured shape. Keys we use:

- ``type``: ``"object" | "array" | "string" | "number" | "boolean" | "null" | "any" | "unknown"``
- ``properties``: ``{name: IntentShape}``                — only on objects
- ``required``: ``list[str]``                            — only on objects
- ``items``: ``IntentShape``                             — only on arrays
- ``enum``: ``list[Any]``                                — for literal unions
- ``description``: ``str``                               — docstring if available
- ``$ref``: ``str``                                      — when transitive resolution gave up
- ``_truncated``: ``True``                               — hit the size cap
- ``format``: ``str``                                    — string format hint
- ``_symbol``: ``str``                                   — original symbol name
"""


class IntentContract(dict[str, Any]):
    """Convenience wrapper — instances ARE plain dicts on the wire.

    >>> c = IntentContract(source="pydantic", path="api.py#User", shape={"type": "object"})
    >>> isinstance(c, dict)
    True
    """

    __slots__ = ()


@runtime_checkable
class IntentSource(Protocol):
    """Source-of-shape contract. Pure — no I/O outside reading the target file.
    Implementations never raise on malformed input; they return ``None``."""

    @property
    def name(self) -> str:
        ...

    def can_parse(self, file_path: str) -> bool:
        ...

    def extract(self, file_path: str, symbol: str | None) -> IntentShape | None:
        ...


def cap_shape_size(shape: IntentShape) -> IntentShape:
    """Truncate a shape so its serialized JSON fits in ``MAX_SHAPE_BYTES``.

    Truncates by replacing nested object/array bodies with
    ``{"_truncated": True}`` starting from the deepest leaves. Top-level
    type/symbol stays so the LLM still gets *something* on huge shapes.
    """
    blob = _safe_dumps(shape)
    if len(blob) <= MAX_SHAPE_BYTES:
        return shape
    for depth in (4, 3, 2, 1):
        candidate = _truncate_at_depth(shape, depth)
        if len(_safe_dumps(candidate)) <= MAX_SHAPE_BYTES:
            return candidate
    out: IntentShape = {"type": shape.get("type", "object"), "_truncated": True}
    if "_symbol" in shape:
        out["_symbol"] = shape["_symbol"]
    return out


def _truncate_at_depth(s: IntentShape, depth: int) -> IntentShape:
    if depth <= 0:
        out: IntentShape = {"_truncated": True}
        if "type" in s:
            out["type"] = s["type"]
        if "_symbol" in s:
            out["_symbol"] = s["_symbol"]
        return out
    out = dict(s)
    if isinstance(s.get("properties"), dict):
        out["properties"] = {
            k: _truncate_at_depth(v, depth - 1)
            for k, v in s["properties"].items()
        }
    if isinstance(s.get("items"), dict):
        out["items"] = _truncate_at_depth(s["items"], depth - 1)
    return out


def _safe_dumps(v: Any) -> str:
    try:
        return json.dumps(v, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return ""
