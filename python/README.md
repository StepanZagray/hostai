# HostAI Python provider SDK

An installable, framework-independent package for Python model providers.
Like an npm library wrapping an API and its validation, this SDK packages the
HostAI protocol—not the model or its weights. HostAI itself remains a separate
gateway process. Python 3.12+ is required.

Install from this repository (not a published PyPI release):

```sh
uv pip install -e /path/to/hostai/python
# or, in an activated virtual environment:
python -m pip install /path/to/hostai/python
```

## Minimal headless provider

```python
from http.server import ThreadingHTTPServer
from hostai import Interaction, Model, Provider

contract = Interaction(
    instructions="Send a string; the result is the same string. Each request is independent.",
    input_schema={"type": "string", "description": "Text to echo."},
    output_schema={"type": "string", "description": "Unchanged input text."},
    examples=[{"description": "Echo hello", "input": "hello", "output": "hello"}],
)
provider = Provider("echo", [Model("echo:latest", infer=lambda value: value, interaction=contract)])

if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 11435), provider.handler()) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
```

The caller explicitly starts and closes the HTTP server. Importing `hostai`
does not bind a socket, load a model, or access the network. Configure HostAI
with `HOSTAI_RUNTIME_URLS=http://127.0.0.1:11435`, then use
`pnpm cli describe echo:latest --json` and `pnpm cli infer echo:latest '"hello"'`.
An inference-only provider without UI is usable from the CLI, but cannot be
selected for visual guest sharing. Supply a custom UI for that experience.

## Add a custom UI

```python
from hostai import CustomUI
provider = Provider("echo", [model], ui=CustomUI("path/to/ui"))
```

`CustomUI` checks the actual entry HTML and directly referenced script, link and
image files. It requires `<script src="hostai-bridge.js"></script>`, rejects
inline scripts/handlers, external or root-absolute HTML asset references,
unsafe paths and escaping symlinks, and bounds each asset to 8 MiB. Paths and
extensions follow the gateway contract. Use relative references so they still
work under `/api/model-ui/<runtime>/...`. Nested entries cannot reference assets
outside their entry directory, which is the gateway's proxy root.

The host supplies the real bridge. The provider UI calls `window.hostai.ready()`
and `window.hostai.infer(input)`; it never receives guest credentials. See the
[bridge contract](../docs/model-ui.md). Static checks do not audit JavaScript,
CSS imports, accessibility or dynamic asset loading. Validate the rendered UI
in HostAI as well. The gateway's sandbox/CSP remains the security boundary.

## Reuse in an existing server

`provider.manifest()` returns fresh JSON-ready metadata. `provider.infer(name,
input)` validates input, invokes the callback, and validates output.
`provider.asset(path)` returns an `Asset(body, content_type)` for safe static
files. These functions can be mounted in any Python HTTP framework; the stdlib
handler is optional. Keep HTTP body and response limits when mounting manually.

`provider.handler(infer_aliases={"/predict": "echo:latest"})` optionally adds a
raw-JSON input route for an existing standalone API. It uses the same validation
and inference path as `/hostai/infer`. Subclass the returned handler's standard
`do_GET` method to add application-specific routes, delegating other requests to
`super().do_GET()`. See [Pebby's integration](../docs/pebby-sdk.md).

The standard HTTP handler serves `GET /hostai/manifest`, `GET /ui/**`, and
`POST /hostai/infer` with `{model, input}`. Inference returns the **raw JSON
result**, not an extra output wrapper. Errors are `{ "error": "message" }`;
bad input/unknown models return 400, implementation or output failures return
generic 500. Empty/malformed inputs fail, bodies and inference replies are at
most 256 KiB, duplicate Content-Length and Transfer-Encoding are rejected, and
connections have a 10-second socket timeout. The handler binds nothing itself;
keep its server on loopback. It is not an internet-facing production server.

## Validation and ownership

`Interaction` requires nonblank instructions, root schema types and descriptions,
descriptions for declared properties, and 1–8 explained input/output examples.
It validates Draft 2020-12 schemas and examples offline; only document-local
references are allowed. The original declarations and returned manifests are
defensively copied. Neither this SDK nor the gateway can prove prose is truthful
or exhaustive. Document state ownership, units, limits, errors and unavailable
features accurately.

Every inference validates JSON input/output. Raise `hostai.InputError` from a
callback for your own domain validation failures; other exceptions are treated
as provider failures. Callbacks must be thread-safe or use their own lock when
served by `ThreadingHTTPServer`. The SDK does not manage GPU concurrency or
interrupt synchronous model execution when a client disconnects.

This initial SDK supports single-response opaque JSON inference, not streaming
callbacks, text chat, async callbacks, model training or engine lifecycle.
It is provider-side; use HostAI's separate [CLI](../docs/cli.md) as a client.

## Develop and distribute

```sh
uv run --project python python -m unittest discover -s python/tests
uv run --project python --group dev ruff check --config python/pyproject.toml python/src python/tests
uv run --project python --group dev ruff format --check --config python/pyproject.toml python/src python/tests
uv build --project python --no-sources
```

The `src/` package layout and `pyproject.toml` build metadata produce a standard
wheel and source distribution, following the [Python Packaging User Guide](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/).
Consumers can install the wheel without this checkout. Pebby uses a relative,
vendored wheel source supported by [uv](https://docs.astral.sh/uv/concepts/projects/dependencies/#path)
until a release is published; no absolute developer path is required. Publishing
and selecting a project license remain separate owner decisions.
