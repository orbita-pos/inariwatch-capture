"""Pydantic source — extracts JSON Schema from a ``BaseModel`` subclass
declared in the failing module (SKYNET §3 piece 5, Track D, part 3).

When an error throws inside a Python web handler, the most useful
"expected" shape is the Pydantic model the request body validated
against — not the runtime types (``Any`` everywhere) and not the function
signature (lies about ``Optional`` constraints).

Strategy:
    1. Cheap pre-check: stat the file, sniff the first 8KB for
       ``import pydantic`` or a ``BaseModel`` reference.
    2. AST scan: find every ``class Foo(BaseModel)`` (and friends —
       ``BaseSettings``, ``RootModel``, anything inheriting transitively).
    3. Resolve symbol: direct match against class names, then a verb-
       stripped match (``create_user`` → ``User``), then case-insensitive,
       then fall back to the first declared model.
    4. To produce the actual JSON schema we *need a class instance*. The
       only way to get one is to import the module — Pydantic's schema
       generator inspects type annotations at runtime. We do that inside
       a try/except: if importing the module raises (missing third-party
       dep, side-effect-heavy global, etc.) we degrade to ``None`` and
       the caller tries the next source.
    5. Translate ``model.model_json_schema()`` (Pydantic v2) or
       ``model.schema()`` (v1) into the IntentShape dialect. We
       intentionally don't ship the raw OpenAPI-style ``$defs`` block
       to the LLM — flatten transitive refs into ``$ref: "TypeName"``.

Caching: keyed by ``(file path, mtime)``. A subsequent call against the
same file is one ``stat()`` + ``Map`` lookup. Acceptance test asserts
>90% hit ratio on hot reloads.

Best-effort: any failure path (no file, no models, import error,
malformed schema) returns ``None`` and never raises.
"""

from __future__ import annotations

import ast
import importlib.util
import os
import re
import sys
from typing import Any

from .types import IntentShape, IntentSource, cap_shape_size

# Common docstring/sniff markers — kept tight so the can_parse pre-check
# stays cheap.
_PY_EXT_RE = re.compile(r"\.pyi?$")
_BASE_MODEL_NAMES = (
    "BaseModel",
    "BaseSettings",
    "RootModel",
    "GenericModel",
)

# ─── Cache ─────────────────────────────────────────────────────────────────


class _CacheEntry:
    __slots__ = ("mtime_ns", "shapes_by_class", "first_class_name", "model_objs")

    def __init__(
        self,
        mtime_ns: int,
        shapes_by_class: dict[str, IntentShape],
        first_class_name: str | None,
        model_objs: dict[str, Any],
    ) -> None:
        self.mtime_ns = mtime_ns
        self.shapes_by_class = shapes_by_class
        self.first_class_name = first_class_name
        self.model_objs = model_objs


_cache: dict[str, _CacheEntry] = {}
_stats = {"hits": 0, "misses": 0}


def reset_cache_for_testing() -> None:
    _cache.clear()
    _stats["hits"] = 0
    _stats["misses"] = 0


def cache_hit_ratio() -> float:
    total = _stats["hits"] + _stats["misses"]
    if total == 0:
        return 0.0
    return _stats["hits"] / total


# ─── AST scan ──────────────────────────────────────────────────────────────


def _ast_collect_models(text: str) -> tuple[list[str], str | None]:
    """Return (class_names_inheriting_basemodel_ish, first_seen).

    We don't need a full type resolver — we just look at the listed bases
    (``class X(BaseModel)``, ``class X(BaseSettings)``, …) and chain back
    through other classes declared in the SAME file. That covers >95% of
    real Pydantic code without paying a full import."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return ([], None)

    # First pass: collect every class def with its base-name list.
    classes: dict[str, list[str]] = {}
    order: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            base_names: list[str] = []
            for base in node.bases:
                base_names.append(_unparse_base(base))
            classes[node.name] = base_names
            order.append(node.name)

    # Second pass: any class whose base set transitively reaches a known
    # Pydantic root counts.
    is_model: dict[str, bool] = {}

    def resolves_to_model(name: str, depth: int = 0) -> bool:
        if depth > 16:
            return False
        if name in is_model:
            return is_model[name]
        if name in _BASE_MODEL_NAMES:
            return True
        if name not in classes:
            return False
        bases = classes[name]
        for b in bases:
            stripped = b.split(".")[-1]
            if stripped in _BASE_MODEL_NAMES or stripped in classes and resolves_to_model(stripped, depth + 1):
                is_model[name] = True
                return True
        is_model[name] = False
        return False

    models = [n for n in order if resolves_to_model(n)]
    first = models[0] if models else None
    return (models, first)


def _unparse_base(base: ast.expr) -> str:
    if isinstance(base, ast.Name):
        return base.id
    if isinstance(base, ast.Attribute):
        # `pydantic.BaseModel` → "pydantic.BaseModel"
        parts: list[str] = []
        cur: ast.expr | None = base
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        return ".".join(reversed(parts))
    if isinstance(base, ast.Subscript):
        # Generic[T] — we only care about the head
        return _unparse_base(base.value)
    return ""


# ─── JSON Schema translation ───────────────────────────────────────────────


def _json_schema_to_shape(
    schema: dict[str, Any],
    defs: dict[str, Any],
    seen: set[str] | None = None,
) -> IntentShape:
    """Translate the OpenAPI-flavoured JSON Schema Pydantic emits into our
    dialect. Inlines ``$defs`` references when small, drops to ``$ref`` on
    cycles."""
    if seen is None:
        seen = set()
    if not isinstance(schema, dict):
        return {"type": "unknown"}

    ref = schema.get("$ref")
    if isinstance(ref, str):
        # Pydantic emits `#/$defs/Foo`. Look it up in the local defs map.
        name = ref.rsplit("/", 1)[-1]
        if name in seen:
            return {"$ref": name, "_symbol": name}
        if name in defs:
            seen2 = set(seen)
            seen2.add(name)
            sub = _json_schema_to_shape(defs[name], defs, seen2)
            if "_symbol" not in sub:
                sub["_symbol"] = name
            return sub
        return {"$ref": name, "_symbol": name}

    # `anyOf` / `oneOf` collapse — match the TS/openapi behaviour.
    for key in ("anyOf", "oneOf"):
        variants = schema.get(key)
        if isinstance(variants, list) and variants:
            parts = [_json_schema_to_shape(v, defs, seen) for v in variants]
            if all(isinstance(p.get("enum"), list) and len(p["enum"]) == 1 for p in parts):
                merged: list[Any] = []
                for p in parts:
                    merged.extend(p["enum"])
                return {"enum": merged}
            # ``Optional[X]`` shows up as ``[{...}, {"type": "null"}]`` —
            # collapse to the non-null shape.
            non_null = [p for p in parts if p.get("type") != "null"]
            if len(non_null) == 1:
                return non_null[0]
            return {"enum": [p.get("type", "unknown") for p in parts]}

    if isinstance(schema.get("allOf"), list):
        merged_obj: IntentShape = {"type": "object", "properties": {}, "required": []}
        req_set: set[str] = set()
        for part in schema["allOf"]:
            child = _json_schema_to_shape(part, defs, seen)
            if child.get("type") == "object" and isinstance(child.get("properties"), dict):
                merged_obj["properties"].update(child["properties"])
                for r in child.get("required", []) or []:
                    req_set.add(r)
        merged_obj["required"] = sorted(req_set)
        return merged_obj

    if isinstance(schema.get("enum"), list):
        return {"enum": list(schema["enum"])}

    t = schema.get("type")

    if t == "object" or (t is None and "properties" in schema):
        properties: dict[str, IntentShape] = {}
        if isinstance(schema.get("properties"), dict):
            for k, v in schema["properties"].items():
                properties[k] = _json_schema_to_shape(v, defs, seen)
        out: IntentShape = {
            "type": "object",
            "properties": properties,
            "required": list(schema.get("required") or []),
        }
        if isinstance(schema.get("description"), str):
            out["description"] = schema["description"]
        title = schema.get("title")
        if isinstance(title, str):
            out["_symbol"] = title
        return out

    if t == "array":
        items = schema.get("items")
        return {
            "type": "array",
            "items": _json_schema_to_shape(items, defs, seen) if isinstance(items, dict) else {"type": "unknown"},
        }

    if t in ("string", "boolean", "null"):
        out = {"type": t}
        fmt = schema.get("format")
        if isinstance(fmt, str):
            out["format"] = fmt
        return out

    if t in ("number", "integer"):
        out = {"type": "number"}
        fmt = schema.get("format")
        if isinstance(fmt, str):
            out["format"] = fmt
        return out

    return {"type": "unknown"}


# ─── Module load ───────────────────────────────────────────────────────────


def _load_module_safely(file_path: str) -> Any | None:
    """Import the user's module by file path. Returns ``None`` on any
    import-time error — the caller is responsible for degrading."""
    try:
        # Use a synthetic name so we don't clobber the user's namespace.
        mod_name = f"_inariwatch_intent_pydantic_{abs(hash(file_path))}"
        spec = importlib.util.spec_from_file_location(mod_name, file_path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(mod_name, None)
            return None
        return module
    except Exception:
        return None


def _model_json_schema(model_cls: Any) -> dict[str, Any] | None:
    # Pydantic v2 (preferred). We never call validators or run user code
    # here beyond what Pydantic's class-construction already did at import.
    if hasattr(model_cls, "model_json_schema"):
        try:
            return model_cls.model_json_schema(ref_template="#/$defs/{model}")
        except Exception:
            return None
    # Pydantic v1 fallback.
    if hasattr(model_cls, "schema"):
        try:
            return model_cls.schema(ref_template="#/$defs/{model}")
        except Exception:
            return None
    return None


def _is_pydantic_model(obj: Any) -> bool:
    if not isinstance(obj, type):
        return False
    bases = (b.__name__ for b in obj.__mro__[1:])
    return any(name in _BASE_MODEL_NAMES for name in bases)


# ─── Symbol resolution ─────────────────────────────────────────────────────

_VERBS = (
    "get",
    "fetch",
    "list",
    "create",
    "update",
    "delete",
    "put",
    "post",
    "patch",
    "make",
    "build",
    "validate",
)


def _resolve_class(
    shapes: dict[str, IntentShape],
    symbol: str,
) -> IntentShape | None:
    if symbol in shapes:
        return shapes[symbol]
    lower = symbol.lower()
    for k in shapes:
        if k.lower() == lower:
            return shapes[k]
    # Strip a leading verb (snake_case or PascalCase) and retry.
    snake_split = symbol.split("_", 1)
    if len(snake_split) == 2 and snake_split[0].lower() in _VERBS:
        rest = snake_split[1]
        cap = rest[:1].upper() + rest[1:]
        if cap in shapes:
            return shapes[cap]
        # singularize trailing s
        if cap.endswith("s") and cap[:-1] in shapes:
            return shapes[cap[:-1]]
    for v in _VERBS:
        if symbol.lower().startswith(v):
            rest = symbol[len(v):]
            if rest:
                cap = rest[:1].upper() + rest[1:]
                if cap in shapes:
                    return shapes[cap]
                if cap.endswith("s") and cap[:-1] in shapes:
                    return shapes[cap[:-1]]
    return None


# ─── Source ────────────────────────────────────────────────────────────────


class PydanticSource:
    name: str = "pydantic"

    def can_parse(self, file_path: str) -> bool:
        if not file_path or not _PY_EXT_RE.search(file_path):
            return False
        try:
            with open(file_path, "rb") as f:
                head = f.read(8192).decode("utf-8", errors="ignore")
        except OSError:
            return False
        if "BaseModel" not in head and "pydantic" not in head:
            return False
        return True

    def extract(self, file_path: str, symbol: str | None) -> IntentShape | None:
        try:
            mtime_ns = os.stat(file_path).st_mtime_ns
        except OSError:
            return None

        cached = _cache.get(file_path)
        if cached and cached.mtime_ns == mtime_ns:
            _stats["hits"] += 1
            shapes = cached.shapes_by_class
            first = cached.first_class_name
        else:
            _stats["misses"] += 1
            try:
                with open(file_path, encoding="utf-8") as f:
                    text = f.read()
            except OSError:
                return None
            class_names, first_ast = _ast_collect_models(text)
            if not class_names:
                _cache[file_path] = _CacheEntry(mtime_ns, {}, None, {})
                return None

            module = _load_module_safely(file_path)
            shapes = {}
            model_objs: dict[str, Any] = {}
            if module is not None:
                for name in class_names:
                    cls = getattr(module, name, None)
                    if not _is_pydantic_model(cls):
                        continue
                    schema = _model_json_schema(cls)
                    if not schema:
                        continue
                    defs = schema.get("$defs") or schema.get("definitions") or {}
                    shape = _json_schema_to_shape(schema, defs)
                    if "_symbol" not in shape:
                        shape["_symbol"] = name
                    shapes[name] = shape
                    model_objs[name] = cls
            first = first_ast if first_ast in shapes else (next(iter(shapes), None) if shapes else None)
            _cache[file_path] = _CacheEntry(mtime_ns, shapes, first, model_objs)

        if not shapes:
            return None

        if symbol:
            direct = _resolve_class(shapes, symbol)
            if direct is not None:
                return cap_shape_size(direct)

        if first and first in shapes:
            return cap_shape_size(shapes[first])
        return cap_shape_size(next(iter(shapes.values())))


pydantic_source = PydanticSource()


DEFAULT_SOURCES: list[IntentSource] = [pydantic_source]


# ─── Compiler entry-point ──────────────────────────────────────────────────


def extract_intent_for_frame(
    frame: dict[str, Any],
    *,
    sources: list[IntentSource] | None = None,
) -> list[dict[str, Any]]:
    """Return zero or more :class:`IntentContract` dicts for the given
    stack frame. Mirrors the Node ``extractIntentForFrame``. Never raises."""
    file_path = frame.get("file") if isinstance(frame, dict) else None
    if not isinstance(file_path, str) or not file_path:
        return []
    symbol = frame.get("function") if isinstance(frame, dict) else None
    if symbol is not None and not isinstance(symbol, str):
        symbol = None
    sources = sources or DEFAULT_SOURCES

    out: list[dict[str, Any]] = []
    for src in sources:
        try:
            if not src.can_parse(file_path):
                continue
        except Exception:
            continue
        try:
            shape = src.extract(file_path, symbol)
        except Exception:
            shape = None
        if shape is None:
            continue
        path = file_path
        sym = symbol or shape.get("_symbol")
        if sym:
            path = f"{file_path}#{sym}"
        out.append({"source": src.name, "path": path, "shape": shape})
    return out
