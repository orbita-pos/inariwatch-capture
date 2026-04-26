"""Shared pytest fixtures.

The Python SDK lives at ``capture/python/`` and the cross-language
fingerprint vectors live at ``<repo-root>/shared/fingerprint-test-vectors.json``.
``REPO_ROOT`` lets individual tests locate shared assets regardless of
``pytest`` invocation directory.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

# capture/python/tests/conftest.py -> capture/python/tests -> capture/python -> capture -> <repo-root>
REPO_ROOT = Path(__file__).resolve().parents[3]
SHARED_DIR = REPO_ROOT / "shared"


@pytest.fixture(scope="session")
def fingerprint_vectors_path() -> Path:
    path = SHARED_DIR / "fingerprint-test-vectors.json"
    if not path.exists():
        pytest.skip(f"Cross-language fingerprint vectors not found at {path}")
    return path


@pytest.fixture(autouse=True)
def _reset_global_state() -> None:
    """Reset module-level singletons between tests.

    Many SDK modules hold private globals (client transport, breadcrumb
    ring, monitoring registration). Importing them lazily here avoids
    circular imports when conftest is collected before the package has
    been built in editable mode.
    """
    # Clear any env overrides that could leak across tests
    for key in list(os.environ):
        if key.startswith("INARIWATCH_"):
            del os.environ[key]

    yield

    # Reset after test too so subsequent tests start clean even if a test
    # set an env var and then raised before cleanup.
    for key in list(os.environ):
        if key.startswith("INARIWATCH_"):
            del os.environ[key]
