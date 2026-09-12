# Pebby integration

Pebby now declares its provider through `pebby/hostai_provider.py`, calls its
existing `Engine.dispatch` from `inference.py`, and loads `ui/hostai-bridge.js`
before its UI scripts. Its `serve.py` mounts the SDK's handler, with only its
application-specific health and standalone bridge-placeholder routes added.

The SDK owns the HostAI manifest, inference request/response validation, and
static asset handling. Pebby owns all six operations and their documentation;
its operation contract is not copied into the generic HostAI package.

From the Pebby checkout:

```sh
uv sync --locked
uv run serve.py --port 11435
```

Start HostAI separately with `HOSTAI_RUNTIME_URLS=http://127.0.0.1:11435`, then:

```sh
pnpm cli describe pebby:latest --json
pnpm cli infer pebby:latest '{"op":"info"}'
```

Pebby keeps `/predict`, `/health` and its standalone UI as well as the standard
HostAI routes. `/predict` is a configured raw-input alias using the same SDK
validation as `/hostai/infer`. Do not bind two provider processes to the same port.

`pyproject.toml` and `uv.lock` use a versioned wheel in `vendor/`, so a clone does
not need the author's local HostAI path. The SDK is not yet published to PyPI.
To refresh that vendored artifact after changing SDK source:

```sh
# From the HostAI checkout; choose a new version for subsequent releases.
uv build --project python --wheel --no-sources --out-dir /path/to/Pebby/vendor
# From Pebby:
uv lock
uv sync --locked
```

For temporary SDK development, `uv run --with-editable /path/to/hostai/python
serve.py` explicitly uses the editable source. Regular `uv run` uses the locked
wheel. Installing with plain pip requires explicitly supplying the wheel, since
`tool.uv.sources` is uv-specific.

The contract documents all six operations: `info`, `generate`, `shipped`,
`play`, `oracle`, and `agent`. It validates the operation envelope; Pebby retains
its detailed level geometry validation. Calls are serialized around the shared
engine. The caller retains the complete level/action history, independently of
whether it uses a UI.

`info` and `agent` may lazily load the policy checkpoint. Set `--checkpoint` to
choose weights. Missing weights produce an explicit unavailable result;
environment operations still work and must not be described as neural-model
predictions. Oracle search and level generation can consume substantial CPU and
memory. The included contract example intentionally describes an unavailable
agent, not a successful trained-policy result.
