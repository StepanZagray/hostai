"""Strict JSON helpers shared by the SDK.

The SDK only ever moves *opaque JSON* around.  ``canonical`` turns arbitrary
Python data into a fresh, JSON-only deep copy (``dict``/``list``/``str``/
``int``/finite ``float``/``bool``/``None``) or raises ``ValueError``.  Because
it round-trips through the ``json`` module it doubles as a defensive copy.
"""

from __future__ import annotations

import json
from typing import Any

__all__ = ["canonical", "dumps", "JSON_TYPES"]

# The seven JSON Schema primitive type names (draft 2020-12).
JSON_TYPES = frozenset({"null", "boolean", "object", "array", "number", "string", "integer"})


def dumps(value: Any) -> bytes:
    """Serialize ``value`` compactly as UTF-8 JSON, rejecting NaN/Infinity."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode(
        "utf-8"
    )


def canonical(value: Any, what: str = "value") -> Any:
    """Return a fresh JSON-only deep copy of ``value``.

    Raises ``ValueError`` when ``value`` contains anything that is not JSON
    (custom objects, bytes, sets, ...) or a non-finite float.
    """
    try:
        _check_keys(value)
        text = json.dumps(value, ensure_ascii=False, allow_nan=False)
        text.encode("utf-8")  # The runtime wire format cannot carry lone surrogates.
    except (TypeError, ValueError, OverflowError, UnicodeError) as exc:
        raise ValueError(f"{what} is not JSON-serializable: {exc}") from None
    except RecursionError:
        raise ValueError(f"{what} is nested too deeply to be JSON") from None
    try:
        return json.loads(text)
    except (ValueError, RecursionError) as exc:  # pragma: no cover - defensive
        raise ValueError(f"{what} is not valid JSON: {exc}") from None


def _check_keys(value: Any) -> None:
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings")
        for item in value.values():
            _check_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _check_keys(item)
