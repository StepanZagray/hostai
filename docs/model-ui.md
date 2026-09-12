# Model UI and the runtime protocol

A runtime is a local HTTP server that HostAI discovers, proxies inference to,
and optionally hosts a user interface for. Ollama is one runtime, reached
through a built-in adapter. Any other process (for example a Python world
model) can speak the small HostAI runtime protocol below directly. A runtime
that declares a UI and supports opaque inference replaces the chat panel in
Playground and on the guest page with its own sandboxed page. Otherwise a model
gets the default chat interface only if it declares chat support. A model with
neither interface remains listed, shows **No supported interface** in Playground,
and cannot be enabled for guest access.

HostAI interprets the shared chat contract, but opaque inference payloads
stay JSON values on both ends; the gateway enforces limits, concurrency, sharing
and access keys, and forwards frames unchanged.

## Configuration

`HOSTAI_RUNTIME_URLS` is a comma-separated list of loopback origins. When it is
empty and no OpenAI-compatible origins are set, the gateway uses the single `HOSTAI_OLLAMA_URL` origin (default
`http://127.0.0.1:11434`). Each origin must pass the existing loopback checks:
`http` or `https` scheme, host `127.0.0.1`, `localhost` or `[::1]`, no path, query or
credentials.

For each origin the gateway sends `GET /hostai/manifest`. A `200` JSON response
means the origin speaks the HostAI runtime protocol. Anything else means the
origin is treated as Ollama (`/api/version`, `/api/tags`, `/api/chat`). The
probe happens whenever the model catalog is read; results are not cached across
restarts.

`HOSTAI_OPENAI_URLS` separately declares comma-separated OpenAI-compatible engine
origins (for example an independently started vLLM server). These are not probed
as HostAI/Ollama: discovery uses `GET /v1/models`, and text generation uses
`POST /v1/chat/completions` with SSE. Specify the origin, **without `/v1`**.
Models use default chat; unsupported tool calls and non-text responses fail
explicitly. No API-key configuration, remote engine origins, multimodal messages,
or engine lifecycle management is implemented. Model sizes are unknown (zero in
the catalog), not measured as zero. To combine these with Ollama, explicitly set
both `HOSTAI_RUNTIME_URLS` and `HOSTAI_OPENAI_URLS`.

## Runtime protocol (runtime ⇄ gateway)

### `GET /hostai/manifest`

```json
{
  "protocol": 1,
  "runtime": "pebby",
  "capabilities": { "chat": false, "infer": true },
  "models": [
    {
      "name": "pebby:latest",
      "sizeBytes": 12345,
      "parameterSize": "3.2K",
      "quantization": "F32",
      "modifiedAt": "2026-09-11T07:22:00Z"
    }
  ],
  "ui": { "entry": "/ui/index.html" },
  "interaction": {
    "instructions": "Illustrative contract: replace with your model's actual operations, state handling, limits, and errors.",
    "inputSchema": { "type": "object", "description": "Provider-defined operation request." },
    "outputSchema": { "type": "object", "description": "Provider-defined operation result." },
    "examples": [{ "description": "Illustrative inspection request; replace with a real example.", "input": { "op": "info" }, "output": { "ok": true } }]
  }
}
```

- `protocol` must be `1`.
- `runtime` is the runtime id: `^[a-z0-9][a-z0-9-]{0,31}$`. It must be unique
  among configured runtimes; a duplicate id makes the later runtime unavailable.
- `models[].name` follows the same admission rules as Ollama model names.
  `sizeBytes` is a non-negative integer; the other fields are strings and may be
  empty.
- `capabilities` declares the supported wire contracts, independently of `ui`:
  `chat` enables `POST /hostai/chat`; `infer` enables `POST /hostai/infer`.
  Both fields must be JSON booleans. A missing, non-boolean, or malformed field
  inside an explicit declaration invalidates the manifest. Explicit `null` is
  invalid. Unknown capability fields are ignored for forward compatibility.
  A model may override both flags with its own `models[].capabilities` object;
  otherwise it inherits the runtime declaration. If the runtime declaration is
  omitted, the legacy default is `{ "chat": false, "infer": true }`, including
  when no UI is supplied. Omitting a UI never grants chat support.
- `ui` is optional. `entry` is an HTML file in a dedicated directory (for example
  `/ui/index.html`; a root-level `/index.html` is rejected), starting with `/`, with no
  `..`, query or fragment, at most 8 segments, each segment matching
  `[A-Za-z0-9._-]+`. The directory containing `entry` is the **UI root**; the
  gateway proxies every path under it and nothing else.
  Models with `infer: false` do not receive this UI in their catalog metadata.
  A model with both capabilities and a UI uses its custom interface; its chat
  endpoint remains callable. There is no UI switch control.

### Required headless interaction contract

Every model with `infer: true` must have an `interaction` object, inherited from
the runtime or replaced by `models[].interaction`. A missing contract invalidates
the manifest even if its custom UI works. This is a breaking validation change
for older providers, including Pebby's existing hand-written manifest: add the
contract before connecting to this gateway. The illustrative manifest above is
not Pebby's actual operation documentation.

The contract contains:

- `instructions`: nonblank explanation, at most 16384 characters. Explain the
  operations, caller-owned state, limits, errors, and optional/unavailable features.
  Text limits count Unicode code points consistently in Java and Python.
- `inputSchema` and `outputSchema`: JSON Schema objects with a single root `type`
  and nonblank `description` (at most 4096 characters). Output describes each
  inference `event` value, not the surrounding HostAI NDJSON envelope.
- `examples`: one to eight objects, each with a nonblank `description` (at most
  1024 characters), `input`, and `output`. JSON null is a valid example value.

The Java gateway checks the presence and structure of this documentation; it
does not evaluate arbitrary JSON Schemas or validate inference values against
them. The [Python provider SDK](../python/README.md) additionally checks schema
validity, example conformance, and live input/output, without fetching external
schema references. Neither check proves that prose is truthful or sufficient
for every task; the provider owns that documentation.

`GET /api/models` exposes each model's contract as `interaction`. An authorized
guest receives only its model's contract from `GET /guest/v1/session` (and the
existing WebSocket session response). `hostai describe MODEL --json` exposes it
without loading UI files or executing the model. For standard chat, the CLI
describes HostAI's fixed text-message contract instead. See [CLI usage](cli.md).

### Default chat and execution ownership

A provider that wants HostAI's default chat interface can return:

```json
{
  "protocol": 1,
  "runtime": "my-runtime",
  "capabilities": { "chat": true, "infer": false },
  "models": [{ "name": "my-model:latest", "sizeBytes": 0 }]
}
```

HostAI owns the transcript, composer, generation settings, conversation context
sent with each request, streaming display and cancellation. The provider can
implement a single model completion or run its own internal agent loop behind
the same endpoint. UI selection does not determine that ownership.

This is a text-chat contract. HostAI does **not** implement an agent tool loop,
MCP integration, persistent provider sessions, tool-activity events, or approval
events. A provider-owned agent may return text through this contract, but rich
agent interaction needs a future session/event adapter or the provider's custom
UI. MCP is not the conversation transport.

### `POST /hostai/chat`

Enabled only for models with `chat: true`. The gateway forwards the shared chat
request unchanged, with the same model-name, message, temperature, token and
262144-byte upload limits as `POST /api/chat`:

```json
{
  "model": "my-model:latest",
  "messages": [{ "role": "user", "content": "Hello" }],
  "temperature": 0.7,
  "maxTokens": 512
}
```

Respond with `200 application/x-ndjson`:

```json
{"content":"Hello","done":false}
{"content":"!","done":true,"outputTokens":2}
```

Each record requires string `content` and boolean `done`. Optional `outputTokens`
must be a non-negative 64-bit integer. An optional string `error` is permitted
only on the terminal record and is sanitized to 256 characters. Terminal errors
are recorded as failed requests, not successful completions. A complete,
non-streamed answer may use `200 application/json` with one record whose `done`
is `true`. An empty, malformed, or unterminated response fails.

Records are bounded to 262144 bytes. Idle and overall generation deadlines,
shared inference slots, request accounting and upstream cancellation also apply
to chat. `400 {"error":"..."}` returns a bounded problem detail to the owner;
other unsuccessful runtime statuses become generic `502` failures. Unsupported
capabilities return `400` without invoking the runtime endpoint. Capability
rejections can still consume a request-history entry and, for guests, a rate-limit
attempt because admission leases are acquired before runtime dispatch.

### `POST /hostai/infer`

Enabled only for models with `infer: true` (the legacy default).

Request: `application/json`, at most 262144 bytes.

```json
{ "model": "pebby:latest", "input": { "board": [[0, 1]], "action": "up" } }
```

`input` is any JSON value. Response is one of:

- `200` with `application/json`: a single JSON value. The gateway emits it as
  one event with `done: true`.
- `200` with `application/x-ndjson`: records `{"event": <json>, "done": bool,
  "error"?: string}`. A record with `done: true` ends the stream. `event` may
  be omitted on the terminal record. An `error` string (at most 256 characters)
  on a terminal record reports a failure after the stream started.
- `400` with `{"error": "..."}`: the request was rejected. The gateway forwards
  the message (at most 256 characters, control characters removed) to the
  client with HTTP 400.
- Any other status: the gateway reports HTTP 502 with a generic message.

Each response record must fit in 262144 bytes. The chat stream idle and
generation deadlines apply.

### `GET <ui root>/**`

Static files for the runtime's UI. The runtime chooses the framework, or none.
The gateway requests each file exactly as the browser asked for it, relative to
the UI root, and sets the browser-facing headers itself.

## Owner API additions (gateway on 8080, proxied by the web app)

- `GET /api/models`: each model gains `"ui": {"runtime": "pebby", "entry":
  "ui/index.html"}` or `"ui": null`. `entry` is the manifest entry relative to
  the runtime asset prefix, without a leading slash.
  Every model also reports `capabilities: {chat, infer}`. Ollama models report
  `{ "chat": true, "infer": false }`. These flags describe supported protocols,
  not model quality or successful loading. Name-based admission rules still apply.
- `POST /api/infer` with `{"model": "...", "input": <json>}` streams NDJSON
  `{"event": <json>, "done": false}` records and ends with `{"done": true}`,
  optionally with `event`, or `{"done": true, "error": "..."}`. It shares the
  concurrency limit and request history with `/api/chat`. Errors before the
  first record are `application/problem+json`. Models served by an Ollama
  runtime respond `400`: they only support `/api/chat`.
- `GET /api/model-ui/{runtime}/{path}`: proxied UI asset. `{runtime}` is a
  runtime id; `{path}` is the runtime's absolute path without its leading
  slash (so the frame for `entry: "/ui/index.html"` loads
  `/api/model-ui/pebby/ui/index.html` and a relative `<script src="app.js">`
  inside it resolves to `/api/model-ui/pebby/ui/app.js`). Segments are
  validated like `entry`. Unknown runtimes, paths outside the UI root, query
  strings and disallowed extensions return `404`. A request whose last segment
  is `hostai-bridge.js` is answered by the gateway with its own bridge script,
  never by the runtime.
- `POST /api/chat` dispatches to Ollama's `/api/chat`, a chat-capable HostAI
  runtime's `/hostai/chat`, or an explicitly configured OpenAI-compatible engine's
  `/v1/chat/completions`. Models without chat support return `400`.
- A manifest that answers `200` but fails validation makes that runtime
  contribute nothing. An origin that cannot be reached at all is treated as
  an offline Ollama runtime.

Allowed asset extensions and the content types the gateway sets, ignoring
whatever the runtime sent: `html`, `js`, `mjs`, `css`, `json`, `svg`, `png`,
`jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`, `woff2`, `wasm`, `txt`, `map`.
Assets over 8 MiB are rejected.

Headers on every model-UI response: `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and the
model-UI Content-Security-Policy. No `X-Frame-Options`, since the host page
must be able to frame it, and no `Cross-Origin-Resource-Policy`, because the
sandboxed frame's opaque origin would otherwise be blocked from loading its
own scripts and styles.

## Guest API additions (guest listener on 8081)

- `GET /guest/v1/session` gains the same `ui` and `capabilities` fields as the
  model record. A model that loses all supported interfaces reports
  `available: false`; an already-connected guest can reconnect after the host
  fixes the runtime. Both the HTTP chat route and public WebSocket chat envelope
  support chat-capable HostAI runtimes under the existing key and request limits.
- `POST /guest/v1/infer`: the local-preview mirror of `/api/infer`, with the
  bearer key and the same rules as `/guest/v1/chat`. On the public channel it
  returns `409` and clients use the WebSocket.
- WebSocket `/guest/v1/chat-stream`: the first message may be
  `{"key": "...", "infer": {"model": "...", "input": <json>}}` instead of
  `{"key": "...", "request": <chat request>}`. Frames are then infer records.
- `GET /guest/v1/model-ui/{runtime}/{path}`: same as the owner asset route, but
  only while guest access is running for a model of that runtime. No key is
  required, because the browser loads the frame with a plain request.

## Model-UI Content-Security-Policy

The frame is loaded with `sandbox="allow-scripts"`, so its origin is opaque. It
has no network and no storage. The server facing the browser (the web app's
proxy for owners, the guest listener for guests) sets:

```
default-src 'none'; script-src 'self' <origin>; style-src 'self' 'unsafe-inline' <origin>;
img-src 'self' data: blob: <origin>; font-src 'self' <origin>; connect-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'self' <origin>
```

`<origin>` is that server's own browser-facing origin. Both `'self'` and the
explicit origin are listed because browsers have differed on how `'self'`
resolves inside a sandboxed document.

The host pages add `frame-src 'self'` to their existing policies and nothing
else changes.

## Bridge protocol (frame ⇄ host page)

The gateway serves `hostai-bridge.js` next to the UI. A model UI includes it
with one script tag and talks to HostAI through `window.hostai`. Under the hood
it is `postMessage` with target `"*"` (the frame's origin is opaque) and strict
source checks: the host accepts messages only from its frame's `contentWindow`,
the frame only from `window.parent`. Every message has `"hostai": 1`.

Frame to host:

| Message | Fields |
| --- | --- |
| `ready` | none. Sent once the bridge has loaded. |
| `infer` | `id` (string, 1–64 chars, unique per frame), `input` (JSON). |
| `cancel` | `id`. |

Host to frame:

| Message | Fields |
| --- | --- |
| `hello` | `model`, `theme` (`"light"` or `"dark"`), `scope` (`"owner"` or `"guest"`). Sent in reply to `ready`. |
| `event` | `id`, `event` (JSON). One per streamed record that carries an event. |
| `done` | `id`. The inference finished. |
| `error` | `id`, `error` (string). The inference failed or was cancelled. |
| `theme` | `theme`. The host theme changed. |

The host allows at most 4 in-flight inferences per frame and answers extra ones
with `error`. Cancellation aborts the upstream request; the frame receives
`error` with `"Cancelled."`.

### `window.hostai` in the frame

- `hostai.ready(): Promise<{model, theme, scope}>` resolves after `hello`.
- `hostai.infer(input, options?): Promise<unknown[]>` sends one inference and
  resolves with every event received, in order. `options.onEvent(event)` is
  called per event; `options.signal` (an `AbortSignal`) cancels.
- `hostai.onTheme(callback): () => void` subscribes to theme changes and
  returns an unsubscribe function. The bridge also sets `data-theme` on
  `<html>` so a UI can style with `[data-theme="dark"]`.
- `hostai.model`, `hostai.theme`, `hostai.scope` hold the latest values.

## Host pages

- **Playground** shows the model select as before. When the selected model has
  `ui` and `infer: true`, the transcript, composer and run settings are replaced by the frame.
  The page then drops its card, gutters and reading width: the interface fills the
  whole content area under the shell's bar, below a slim row keeping the model
  select, the status badge and the API example. Leaving Playground unmounts the
  frame; a model UI keeps its own state and HostAI does not persist it.
- **Guest page** behaves the same once the session reports `ui`.
- Without a usable UI, `chat: true` selects the shared chat panel. With neither,
  both pages show **No supported interface** and hide the composer. Model-library,
  overview and guest-access eligibility use the same interface decision.
- For compatibility with older gateways only, clients infer chat/infer defaults
  when `capabilities` is omitted: no UI means chat, a valid UI means inference.
  Existing chat admission metadata is still required before enabling owner chat.
  Malformed explicit capabilities grant neither contract. Upgrading both gateway
  and frontend is necessary to correct legacy HostAI runtimes without a UI.
- The frame's `src` is the owner or guest asset route for the model's `entry`.
- Owner inference failures with HTTP 400 carry the runtime's bounded message
  as the problem detail, and the owner host page forwards it to the frame.
  Guest host pages never forward server text and show a fixed message.
- Owner inference goes through the same-origin proxy to `POST /api/infer`.
  Guest inference uses `POST /guest/v1/infer` on the local channel and the
  WebSocket on the public channel. The model UI code is identical in all cases.

## Trust boundary

The owner chose to run the runtime, so its UI is the owner's own code. It still
runs with less privilege than the host page: opaque origin, no network, no
storage, no access to the host document, and only the bridge to reach HostAI.
Guests receive that same UI under the same sandbox. Access keys never enter the
frame.
