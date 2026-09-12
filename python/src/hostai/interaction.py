"""The headless interaction contract of a model.

An :class:`Interaction` tells a host (or an agent driving the host) how to talk
to a model without ever loading its custom UI: plain-language instructions,
a JSON Schema for the input, a JSON Schema for the output and one to eight
worked examples.  Everything is validated eagerly in the constructor so a
Provider that builds has structurally checked documentation. Providers remain
responsible for the accuracy and completeness of their explanations.

Schema rules (beyond ``Draft202012Validator.check_schema``):

* the root schema is a JSON object whose ``type`` is a single JSON type name
  and whose ``description`` is non-blank and at most 4096 characters;
* every schema listed under any ``properties`` keyword, at any depth, carries
  such a ``description`` (boolean property schemas cannot, so they are
  rejected);
* ``$ref``/``$dynamicRef`` values must be document-local (``#...``), ``$id``
  is not allowed anywhere and ``$schema`` may only name draft 2020-12; every
  local reference is resolved once at construction time, offline.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError, best_match
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012

from ._json import JSON_TYPES, canonical
from .errors import ContractError

__all__ = ["Interaction"]

MAX_INSTRUCTIONS_CHARS = 16384
MAX_DESCRIPTION_CHARS = 4096
MAX_EXAMPLE_DESCRIPTION_CHARS = 1024
MIN_EXAMPLES = 1
MAX_EXAMPLES = 8

_DRAFT_2020_12_URIS = frozenset(
    {
        "https://json-schema.org/draft/2020-12/schema",
        "https://json-schema.org/draft/2020-12/schema#",
    }
)
_REF_KEYWORDS = ("$ref", "$dynamicRef")
_EXAMPLE_KEYS = frozenset({"description", "input", "output"})


def _check_text(value: Any, what: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{what} must be a string")
    if not value.strip():
        raise ContractError(f"{what} must not be blank")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ContractError(f"{what} must contain valid Unicode text") from None
    if len(value) > limit:
        raise ContractError(f"{what} is {len(value)} characters; limit is {limit}")
    return value


class _CompiledSchema:
    """A validated JSON Schema plus a validator that never touches the network."""

    __slots__ = ("schema", "validator")

    def __init__(self, raw: Any, what: str) -> None:
        if not isinstance(raw, Mapping):
            raise ContractError(f"{what} must be a JSON object (a dict)")
        try:
            schema = canonical(raw, what)
        except ValueError as exc:
            raise ContractError(str(exc)) from None

        type_name = schema.get("type")
        if not isinstance(type_name, str) or type_name not in JSON_TYPES:
            raise ContractError(
                f"{what} root 'type' must be a single JSON type name, one of: "
                + ", ".join(sorted(JSON_TYPES))
            )
        _check_text(schema.get("description"), f"{what} root 'description'", MAX_DESCRIPTION_CHARS)
        declared = schema.get("$schema")
        if declared is not None and declared not in _DRAFT_2020_12_URIS:
            raise ContractError(f"{what} '$schema' must be JSON Schema draft 2020-12")

        refs: list[str] = []
        _walk(schema, what, refs, path="")

        try:
            Draft202012Validator.check_schema(schema)
        except SchemaError as exc:
            raise ContractError(f"{what} is not a valid JSON Schema: {exc.message}") from None

        # Register the document under the empty URI so "#..." references
        # resolve against it and nothing else can ever be retrieved.
        resource = Resource.from_contents(schema, default_specification=DRAFT202012)
        registry: Registry[Any] = Registry().with_resource(uri="", resource=resource)
        resolver = registry.resolver(base_uri="")
        for ref in refs:
            try:
                resolver.lookup(ref)
            except Unresolvable as exc:
                raise ContractError(f"{what} reference {ref!r} cannot be resolved: {exc}") from None

        self.schema = schema
        self.validator = Draft202012Validator(schema, registry=registry)

    def error_for(self, instance: Any) -> str | None:
        """Return a human readable validation error, or ``None`` if valid."""
        error: ValidationError | None = best_match(self.validator.iter_errors(instance))
        if error is None:
            return None
        location = "/".join(str(part) for part in error.absolute_path)
        where = f" at '/{location}'" if location else " at the root"
        return f"{error.message}{where}"


def _walk(node: Any, what: str, refs: list[str], path: str) -> None:
    """Recursively enforce ref locality, forbid ``$id`` and require property docs."""
    if isinstance(node, list):
        for index, item in enumerate(node):
            _walk(item, what, refs, f"{path}/{index}")
        return
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        here = f"{path}/{key}"
        if key == "$id":
            raise ContractError(f"{what} must not use '$id' (at '{here}'); schemas are embedded")
        if key == "$schema" and path:
            raise ContractError(
                f"{what} may only declare '$schema' at the root (found at '{here}')"
            )
        if key in _REF_KEYWORDS:
            if not isinstance(value, str) or not value.startswith("#"):
                raise ContractError(
                    f"{what} reference at '{here}' must be document-local (start with '#'); "
                    "remote references are not allowed"
                )
            refs.append(value)
            continue
        if key == "properties" and isinstance(value, dict):
            for name, prop in value.items():
                prop_path = f"{here}/{name}"
                if not isinstance(prop, dict):
                    raise ContractError(
                        f"{what} property '{name}' (at '{prop_path}') must be an object schema with a description"
                    )
                _check_text(
                    prop.get("description"),
                    f"{what} property '{name}' 'description' (at '{prop_path}')",
                    MAX_DESCRIPTION_CHARS,
                )
                _walk(prop, what, refs, prop_path)
            continue
        _walk(value, what, refs, here)


class Interaction:
    """Instructions, input/output schemas and examples for headless use.

    All arguments are copied; the properties return fresh copies, so neither
    the caller nor a consumer can mutate the contract after construction.
    """

    __slots__ = ("_instructions", "_input", "_output", "_examples")

    def __init__(
        self,
        instructions: str,
        input_schema: Mapping[str, Any],
        output_schema: Mapping[str, Any],
        examples: Sequence[Mapping[str, Any]],
    ) -> None:
        self._instructions = _check_text(instructions, "instructions", MAX_INSTRUCTIONS_CHARS)
        self._input = _CompiledSchema(input_schema, "input_schema")
        self._output = _CompiledSchema(output_schema, "output_schema")
        self._examples = self._check_examples(examples)

    # -- construction helpers -------------------------------------------------

    def _check_examples(self, examples: Any) -> list[dict[str, Any]]:
        if isinstance(examples, (str, bytes, Mapping)) or not isinstance(examples, Sequence):
            raise ContractError("examples must be a list of example objects")
        if not MIN_EXAMPLES <= len(examples) <= MAX_EXAMPLES:
            raise ContractError(
                f"examples must contain between {MIN_EXAMPLES} and {MAX_EXAMPLES} entries, got {len(examples)}"
            )
        checked: list[dict[str, Any]] = []
        for index, raw in enumerate(examples):
            what = f"examples[{index}]"
            if not isinstance(raw, Mapping):
                raise ContractError(f"{what} must be an object")
            keys = set(raw.keys())
            if keys != _EXAMPLE_KEYS:
                raise ContractError(
                    f"{what} must have exactly the keys description, input and output; got "
                    + ", ".join(sorted(map(str, keys)))
                )
            try:
                example = canonical(raw, what)
            except ValueError as exc:
                raise ContractError(str(exc)) from None
            _check_text(
                example["description"], f"{what} 'description'", MAX_EXAMPLE_DESCRIPTION_CHARS
            )
            problem = self._input.error_for(example["input"])
            if problem is not None:
                raise ContractError(f"{what} 'input' does not conform to input_schema: {problem}")
            problem = self._output.error_for(example["output"])
            if problem is not None:
                raise ContractError(f"{what} 'output' does not conform to output_schema: {problem}")
            checked.append(example)
        return checked

    # -- read-only views ------------------------------------------------------

    @property
    def instructions(self) -> str:
        return self._instructions

    @property
    def input_schema(self) -> dict[str, Any]:
        return canonical(self._input.schema)

    @property
    def output_schema(self) -> dict[str, Any]:
        return canonical(self._output.schema)

    @property
    def examples(self) -> list[dict[str, Any]]:
        return canonical(self._examples)

    # -- runtime checks -------------------------------------------------------

    def input_error(self, instance: Any) -> str | None:
        """Describe why ``instance`` violates the input schema, or ``None``."""
        return self._input.error_for(instance)

    def output_error(self, instance: Any) -> str | None:
        """Describe why ``instance`` violates the output schema, or ``None``."""
        return self._output.error_for(instance)

    def to_manifest(self) -> dict[str, Any]:
        """The ``interaction`` block of a manifest model entry (fresh copy)."""
        return {
            "instructions": self._instructions,
            "inputSchema": self.input_schema,
            "outputSchema": self.output_schema,
            "examples": self.examples,
        }

    def __repr__(self) -> str:
        return (
            f"Interaction(instructions={self._instructions[:40]!r}..., "
            f"examples={len(self._examples)})"
        )
