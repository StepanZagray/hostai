"""Models and the Provider that publishes them.

A :class:`Provider` is the single object a HostAI provider process needs: it
produces the manifest, runs validated inference and serves UI assets.  It is
immutable once built and safe to share between threads as long as the
``infer`` callables are.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Any

from ._json import canonical, dumps
from .errors import (
    AssetError,
    ContractError,
    InferenceError,
    InputError,
    OutputError,
    UnknownModelError,
)
from .interaction import Interaction
from .ui import Asset, CustomUI

__all__ = ["Model", "Provider", "PROTOCOL_VERSION", "MAX_MANIFEST_BYTES"]

PROTOCOL_VERSION = 1
MAX_MANIFEST_BYTES = 262_144
MAX_MODEL_NAME_CHARS = 128
RUNTIME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
_MODEL_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")


class Model:
    """One inferable model: a name, an ``infer`` callable and its contract.

    ``infer`` receives a fresh JSON copy of the validated input and must return
    JSON data conforming to ``interaction.output_schema``.  It may be called
    from several threads at once when served by ``ThreadingHTTPServer``.
    """

    __slots__ = ("_name", "_infer", "_interaction", "_size_bytes", "_metadata")

    def __init__(
        self,
        name: str,
        infer: Callable[[Any], Any],
        interaction: Interaction,
        size_bytes: int = 0,
        *,
        parameter_size: str = "",
        quantization: str = "",
        modified_at: str = "",
    ) -> None:
        if (
            not isinstance(name, str)
            or not _MODEL_NAME_RE.fullmatch(name)
            or name.endswith((":cloud", "-cloud"))
        ):
            raise ContractError(
                "model name must be 1-128 characters of letters, digits and . _ : / -, "
                "starting with a letter or digit; cloud models are not supported"
            )
        if not callable(infer):
            raise ContractError(f"model {name!r}: infer must be callable")
        if not isinstance(interaction, Interaction):
            raise ContractError(f"model {name!r}: interaction must be an hostai.Interaction")
        if (
            isinstance(size_bytes, bool)
            or not isinstance(size_bytes, int)
            or not 0 <= size_bytes <= 2**63 - 1
        ):
            raise ContractError(f"model {name!r}: size_bytes must be a non-negative integer")
        self._name = name
        self._infer = infer
        self._interaction = interaction
        self._size_bytes = size_bytes
        self._metadata = {
            "parameterSize": parameter_size,
            "quantization": quantization,
            "modifiedAt": modified_at,
        }
        if any(not isinstance(value, str) for value in self._metadata.values()):
            raise ContractError("model metadata must be strings")

    @property
    def name(self) -> str:
        return self._name

    @property
    def size_bytes(self) -> int:
        return self._size_bytes

    @property
    def interaction(self) -> Interaction:
        return self._interaction

    @property
    def infer(self) -> Callable[[Any], Any]:
        return self._infer

    def to_manifest(self) -> dict[str, Any]:
        return {
            "name": self._name,
            "sizeBytes": self._size_bytes,
            "capabilities": {"chat": False, "infer": True},
            "interaction": self._interaction.to_manifest(),
            **self._metadata,
        }

    def __repr__(self) -> str:
        return f"Model(name={self._name!r}, size_bytes={self._size_bytes})"


class Provider:
    """A runtime identifier, one or more models and an optional custom UI."""

    __slots__ = ("_runtime", "_models", "_by_name", "_ui")

    def __init__(
        self,
        runtime: str,
        models: Iterable[Model],
        ui: CustomUI | None = None,
    ) -> None:
        if not isinstance(runtime, str) or not RUNTIME_RE.fullmatch(runtime):
            raise ContractError(
                "runtime must match [a-z0-9][a-z0-9-]{0,31}: lowercase letters, digits and hyphens"
            )
        if isinstance(models, Model) or isinstance(models, (str, bytes)):
            raise ContractError("models must be an iterable of hostai.Model")
        try:
            model_list = tuple(models)
        except TypeError:
            raise ContractError("models must be an iterable of hostai.Model") from None
        if not model_list:
            raise ContractError("a provider needs at least one model")
        by_name: dict[str, Model] = {}
        for model in model_list:
            if not isinstance(model, Model):
                raise ContractError("models must only contain hostai.Model instances")
            if model.name in by_name:
                raise ContractError(f"duplicate model name {model.name!r}")
            by_name[model.name] = model
        if ui is not None and not isinstance(ui, CustomUI):
            raise ContractError("ui must be an hostai.CustomUI or None")
        self._runtime = runtime
        self._models = model_list
        self._by_name = by_name
        self._ui = ui
        size = len(self.manifest_bytes())
        if size > MAX_MANIFEST_BYTES:
            raise ContractError(f"manifest is {size} bytes; limit is {MAX_MANIFEST_BYTES}")

    # -- read-only views ------------------------------------------------------

    @property
    def runtime(self) -> str:
        return self._runtime

    @property
    def models(self) -> tuple[Model, ...]:
        return self._models

    @property
    def ui(self) -> CustomUI | None:
        return self._ui

    def model(self, name: str) -> Model:
        """Look a model up by name; raises :class:`UnknownModelError`."""
        if not isinstance(name, str) or name not in self._by_name:
            raise UnknownModelError(f"unknown model {name!r}")
        return self._by_name[name]

    # -- manifest -------------------------------------------------------------

    def manifest(self) -> dict[str, Any]:
        """Build a fresh manifest dict (never a shared reference)."""
        return {
            "protocol": PROTOCOL_VERSION,
            "runtime": self._runtime,
            "models": [model.to_manifest() for model in self._models],
            "ui": self._ui.to_manifest() if self._ui is not None else None,
        }

    def manifest_bytes(self) -> bytes:
        """The manifest serialized as compact UTF-8 JSON."""
        return dumps(self.manifest())

    # -- inference ------------------------------------------------------------

    def infer(self, model: str, input: Any) -> Any:
        """Validate ``input``, run the model and validate its output.

        Returns a fresh JSON copy of the output.  Raises
        :class:`UnknownModelError`, :class:`InputError` (bad input),
        :class:`InferenceError` (callable raised) or :class:`OutputError`
        (non-JSON or non-conforming output).
        """
        target = self.model(model)
        try:
            payload = canonical(input, "input")
        except ValueError as exc:
            raise InputError(str(exc)) from None
        problem = target.interaction.input_error(payload)
        if problem is not None:
            raise InputError(f"input does not conform to the input schema: {problem}")
        try:
            raw = target.infer(payload)
        except InputError:
            raise  # Providers may explicitly classify their own validation failures.
        except Exception as exc:
            raise InferenceError(f"model {model!r} failed during inference") from exc
        try:
            output = canonical(raw, "output")
        except ValueError as exc:
            raise OutputError(f"model {model!r} returned invalid output: {exc}") from None
        problem = target.interaction.output_error(output)
        if problem is not None:
            raise OutputError(
                f"model {model!r} output does not conform to the output schema: {problem}"
            )
        return output

    # -- UI -------------------------------------------------------------------

    def asset(self, path: str) -> Asset:
        """Serve one UI file; see :meth:`CustomUI.asset`."""
        if self._ui is None:
            raise AssetError("this provider has no custom UI")
        return self._ui.asset(path)

    # -- HTTP -----------------------------------------------------------------

    def handler(self, *, infer_aliases: dict[str, str] | None = None) -> type:
        """A ``BaseHTTPRequestHandler`` subclass bound to this provider.

        Nothing listens until the caller creates a server, e.g.::

            server = ThreadingHTTPServer(("127.0.0.1", 0), provider.handler())
        """
        from .http import make_handler

        return make_handler(self, infer_aliases=infer_aliases)

    def __repr__(self) -> str:
        names = ", ".join(model.name for model in self._models)
        return f"Provider(runtime={self._runtime!r}, models=[{names}], ui={self._ui is not None})"
