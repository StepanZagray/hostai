"""HostAI provider SDK.

Build a provider from four small objects::

    import hostai

    contract = hostai.Interaction(
        instructions="Echo the text back.",
        input_schema={"type": "object", "description": "Echo request",
                      "properties": {"text": {"type": "string", "description": "Text"}},
                      "required": ["text"], "additionalProperties": False},
        output_schema={"type": "object", "description": "Echo reply",
                       "properties": {"text": {"type": "string", "description": "Text"}},
                       "required": ["text"]},
        examples=[{"description": "Round trip", "input": {"text": "hi"}, "output": {"text": "hi"}}],
    )
    model = hostai.Model("echo", infer=lambda data: {"text": data["text"]}, interaction=contract)
    provider = hostai.Provider(runtime="echo", models=[model])   # ui=hostai.CustomUI("ui") optional

    provider.manifest()               # fresh JSON-ready dict
    provider.infer("echo", {"text": "hi"})
    provider.asset("index.html")      # only when a CustomUI was given
    provider.handler()                # BaseHTTPRequestHandler subclass for ThreadingHTTPServer

Importing this package never starts a server and never touches the network.
"""

from __future__ import annotations

from .errors import (
    AssetError,
    ContractError,
    HostAIError,
    InferenceError,
    InputError,
    OutputError,
    UnknownModelError,
)
from .interaction import Interaction
from .provider import MAX_MANIFEST_BYTES, PROTOCOL_VERSION, Model, Provider
from .ui import BRIDGE_SCRIPT, MAX_ASSET_BYTES, Asset, CustomUI

__version__ = "0.1.0"

__all__ = [
    "Asset",
    "AssetError",
    "BRIDGE_SCRIPT",
    "ContractError",
    "CustomUI",
    "HostAIError",
    "InferenceError",
    "InputError",
    "Interaction",
    "MAX_ASSET_BYTES",
    "MAX_MANIFEST_BYTES",
    "Model",
    "OutputError",
    "PROTOCOL_VERSION",
    "Provider",
    "UnknownModelError",
    "__version__",
]
