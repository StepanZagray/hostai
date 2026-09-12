"""Exception hierarchy for the HostAI provider SDK.

Every error raised on purpose by this package derives from :class:`HostAIError`
so callers can catch one type.  The HTTP layer maps them to status codes:

* :class:`ContractError`   -- raised while *building* objects; never at runtime.
* :class:`UnknownModelError` -- 400
* :class:`InputError`      -- 400 (the caller's request was invalid)
* :class:`InferenceError`  -- 500, generic body (the ``infer`` callable raised)
* :class:`OutputError`     -- 500, generic body (the callable returned bad data)
* :class:`AssetError`      -- 404 (missing, unsafe or unsupported UI asset)
"""

from __future__ import annotations

__all__ = [
    "AssetError",
    "ContractError",
    "HostAIError",
    "InferenceError",
    "InputError",
    "OutputError",
    "UnknownModelError",
]


class HostAIError(Exception):
    """Base class for every error raised by :mod:`hostai`."""


class ContractError(HostAIError, ValueError):
    """An Interaction, CustomUI, Model or Provider was built from invalid data."""


class UnknownModelError(HostAIError, LookupError):
    """The requested model name is not published by this provider."""


class InputError(HostAIError, ValueError):
    """The inference input is not JSON or does not conform to the input schema."""


class InferenceError(HostAIError):
    """The provider's ``infer`` callable raised; the cause is chained."""


class OutputError(HostAIError):
    """The ``infer`` callable returned non-JSON, non-finite or non-conforming data."""


class AssetError(HostAIError, LookupError):
    """A UI asset path is missing, unsafe, unsupported or too large."""
