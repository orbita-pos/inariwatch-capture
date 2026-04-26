"""Pydantic intent source tests (SKYNET §3 piece 5, Track D, part 3)."""

from __future__ import annotations

import importlib.util
import os
import textwrap
from pathlib import Path

import pytest

HAS_PYDANTIC = importlib.util.find_spec("pydantic") is not None

pytestmark = pytest.mark.skipif(not HAS_PYDANTIC, reason="pydantic not installed")


def _write_module(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "user_app.py"
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return p


def test_extracts_basemodel_subclass(tmp_path: Path) -> None:
    from inariwatch_capture.intent import (
        extract_intent_for_frame,
        reset_cache_for_testing,
    )

    reset_cache_for_testing()
    file = _write_module(
        tmp_path,
        """
        from pydantic import BaseModel

        class CreateUserInput(BaseModel):
            email: str
            age: int | None = None
            tags: list[str] = []
        """,
    )

    contracts = extract_intent_for_frame({"file": str(file), "function": "CreateUserInput"})
    pyd = next((c for c in contracts if c["source"] == "pydantic"), None)
    assert pyd is not None
    shape = pyd["shape"]
    assert shape["type"] == "object"
    assert shape["_symbol"] == "CreateUserInput"
    assert shape["properties"]["email"]["type"] == "string"
    # age may inline `Optional[int]` → number (anyOf-collapsed)
    assert shape["properties"]["age"]["type"] == "number"
    assert shape["properties"]["tags"]["type"] == "array"
    assert shape["properties"]["tags"]["items"]["type"] == "string"
    assert "email" in shape["required"]
    assert "age" not in shape["required"]


def test_resolves_via_verb_stripped_symbol(tmp_path: Path) -> None:
    from inariwatch_capture.intent import (
        extract_intent_for_frame,
        reset_cache_for_testing,
    )

    reset_cache_for_testing()
    file = _write_module(
        tmp_path,
        """
        from pydantic import BaseModel

        class User(BaseModel):
            id: str
            email: str
        """,
    )
    contracts = extract_intent_for_frame({"file": str(file), "function": "create_user"})
    pyd = next((c for c in contracts if c["source"] == "pydantic"), None)
    assert pyd is not None
    assert pyd["shape"]["_symbol"] == "User"


def test_falls_back_to_first_model_when_symbol_unknown(tmp_path: Path) -> None:
    from inariwatch_capture.intent import (
        extract_intent_for_frame,
        reset_cache_for_testing,
    )

    reset_cache_for_testing()
    file = _write_module(
        tmp_path,
        """
        from pydantic import BaseModel

        class Foo(BaseModel):
            x: int

        class Bar(BaseModel):
            y: str
        """,
    )
    contracts = extract_intent_for_frame({"file": str(file), "function": "totallyUnknown"})
    pyd = next((c for c in contracts if c["source"] == "pydantic"), None)
    assert pyd is not None
    assert pyd["shape"]["_symbol"] == "Foo"


def test_file_without_pydantic_returns_no_contract(tmp_path: Path) -> None:
    from inariwatch_capture.intent import (
        extract_intent_for_frame,
        reset_cache_for_testing,
    )

    reset_cache_for_testing()
    file = tmp_path / "plain.py"
    file.write_text("def handler():\n    return 42\n", encoding="utf-8")
    contracts = extract_intent_for_frame({"file": str(file), "function": "handler"})
    assert contracts == []


def test_cache_hit_on_repeated_extract(tmp_path: Path) -> None:
    from inariwatch_capture.intent import (
        cache_hit_ratio,
        extract_intent_for_frame,
        reset_cache_for_testing,
    )

    reset_cache_for_testing()
    file = _write_module(
        tmp_path,
        """
        from pydantic import BaseModel

        class Item(BaseModel):
            sku: str
        """,
    )
    for _ in range(20):
        extract_intent_for_frame({"file": str(file), "function": "Item"})
    # 1 miss + 19 hits → > 90%
    assert cache_hit_ratio() > 0.9


def test_handles_invalid_python_gracefully(tmp_path: Path) -> None:
    from inariwatch_capture.intent import (
        extract_intent_for_frame,
        reset_cache_for_testing,
    )

    reset_cache_for_testing()
    file = tmp_path / "broken.py"
    file.write_text("from pydantic import BaseModel\nclass Broken(BaseModel: # syntax error\n", encoding="utf-8")
    contracts = extract_intent_for_frame({"file": str(file), "function": "Broken"})
    assert contracts == []  # never raises
    assert os.path.exists(file)


def test_handles_missing_file_gracefully() -> None:
    from inariwatch_capture.intent import (
        extract_intent_for_frame,
        reset_cache_for_testing,
    )

    reset_cache_for_testing()
    contracts = extract_intent_for_frame({"file": "/no/such/file.py", "function": "X"})
    assert contracts == []
