# HostAI backend

Java 26, Spring Boot 4.1.1, Maven Wrapper 3.3.4 / Maven 3.9.12. No preview
features. Owner controls remain **unauthenticated and localhost-only** on
`127.0.0.1:8080`. A separate guest listener on `127.0.0.1:8081` requires expiring,
model-scoped access keys and starts only when the owner enables it. Grants and
revocation are durable; request history and counters remain in memory. An
owner-issued key is recoverable: `grants.json` (schema version 3, mode 0600
inside a 0700 directory) retains its secret so the host can read the key back at
any time, while a key a guest chose through an access request is stored only as
a hash and can never be shown again. Optional
Cloudflare Quick Tunnel sharing uses an independent ephemeral guest listener and
internet-only keys. Account systems and verified host identities are not implemented.
See [guest access](../docs/guest-access.md) for the complete boundary and contract.

## Run

From this repository:

```sh
pnpm --filter @hostai/web build:guest
cd backend
JAVA_HOME=/usr/lib/jvm/java-26-openjdk ./mvnw spring-boot:run
```

This selects Java for that process only; it does not change system Java. The
wrapper bootstraps its pinned Apache wrapper JAR and Maven distribution from
Maven Central over HTTPS. The initial build needs network access, `curl`, and a
JDK. Subsequent builds reuse the local Maven cache.

To use another local Ollama port:

```sh
HOSTAI_OLLAMA_URL=http://127.0.0.1:11435 \
JAVA_HOME=/usr/lib/jvm/java-26-openjdk ./mvnw spring-boot:run
```

`HOSTAI_OLLAMA_URL` defaults to `http://127.0.0.1:11434`. Only HTTP(S) origins
whose host is `127.0.0.1`, `localhost`, or `[::1]` are accepted. Credentials,
paths, queries, and fragments are rejected. `localhost` is pinned to
`127.0.0.1` without DNS resolution. Redirects and automatic connection retries
are disabled. An explicit model-download job invokes Ollama's `/api/pull`;
metadata reads and chat never start a download. A chat may cause Ollama to load
an already installed model.
Known `:cloud` and `-cloud` model names are rejected. The operator must keep
Ollama itself configured for local inference; a gateway cannot enforce what an
independently configured upstream proxy does internally.

To add other local runtimes:

```sh
HOSTAI_RUNTIME_URLS=http://127.0.0.1:11434,http://127.0.0.1:9090 \
JAVA_HOME=/usr/lib/jvm/java-26-openjdk ./mvnw spring-boot:run
```

`HOSTAI_RUNTIME_URLS` (property `hostai.runtime-urls=${HOSTAI_RUNTIME_URLS:}`)
is a comma-separated list of loopback origins, each validated with the same
rules as `HOSTAI_OLLAMA_URL`. If both it and `HOSTAI_OPENAI_URLS` are empty, discovery uses the single
`HOSTAI_OLLAMA_URL` origin. Every model catalog read sends each origin
`GET /hostai/manifest`: a `200` JSON response means the origin speaks the
HostAI runtime protocol; anything else, including an unreachable origin, means
it is treated as Ollama. A duplicate runtime id makes the later origin
unavailable; a duplicate model name keeps the first origin's entry. Model
downloads (`/api/model-downloads`) always target `HOSTAI_OLLAMA_URL`, never
the other configured runtimes. See [the model-UI contract](../docs/model-ui.md)
for the runtime protocol, the model-UI asset route, and `/api/infer`.

`HOSTAI_OPENAI_URLS` (`hostai.openai-urls`) explicitly selects loopback
OpenAI-compatible servers, without a `/v1` path suffix. The adapter reads
`/v1/models` and streams `/v1/chat/completions` SSE into HostAI chat records.
Tools, multimodal requests and engine launch/management are not supported.
The model catalog and authorized guest session include `interaction` metadata;
inference providers without instructions, schemas and examples are rejected.
Use the root [CLI](../docs/cli.md) to discover and invoke either contract headlessly.

Build the guest assets from the repository root with `pnpm build` before testing
or packaging Java. Maven embeds `apps/web/dist/guest` in the JAR. Rebuild both when
the guest page changes. To build an executable JAR:

```sh
JAVA_HOME=/usr/lib/jvm/java-26-openjdk ./mvnw verify
/usr/lib/jvm/java-26-openjdk/bin/java -jar target/hostai-backend-0.1.0.jar
```

## API contract

All paths below are relative to `http://127.0.0.1:8080`. JSON property names are
case sensitive. Dates are ISO 8601 strings. The machine-readable timestamps in
request history use UTC. No endpoint returns prompts or generated text except
the chat response itself.

### `GET /api/status`

Always reports the backend as online if this request succeeds. `ollamaConnected`
is true when any configured runtime answers its own liveness probe: Ollama's
`/api/version`, or a HostAI runtime's `/hostai/manifest`. It does not mean a
model is loaded. `ollamaUrl` is every configured runtime origin, as typed,
joined with `", "`.

```json
{
  "status": "online",
  "ollamaConnected": false,
  "ollamaUrl": "http://127.0.0.1:11434",
  "version": "0.1.0",
  "javaVersion": "26.0.2.1",
  "uptimeSeconds": 120,
  "activeRequests": 0,
  "maxConcurrentRequests": 2,
  "totalRequests": 0,
  "failedRequests": 0
}
```

`version` is the packaged backend version. `javaVersion` is read from the running
JVM; uptime is JVM uptime in whole seconds. Counters cover **admitted chat
requests**, including ones which subsequently find Ollama unavailable. Validation
and overload rejections do not increment them. Cancelled requests count toward
the total but not failed requests. Status/model/history/health reads do not
consume inference slots or change these counters.

### `GET /api/models`

Merges every configured runtime's catalog read. For an Ollama-protocol runtime
this converts `/api/tags`: `size` → `sizeBytes`, `details.parameter_size` →
`parameterSize`, `details.quantization_level` → `quantization`, and
`modified_at` → `modifiedAt`. A HostAI runtime's manifest models map field for
field, with `sizeBytes` required and the other descriptive fields defaulting to
an empty string.

```json
{
  "models": [{
    "name": "example:latest",
    "sizeBytes": 5000000000,
    "parameterSize": "8B",
    "quantization": "Q4_K_M",
    "modifiedAt": "2026-09-01T12:00:00Z",
    "chatUnavailableReason": null,
    "ui": null,
    "capabilities": {"chat": true, "infer": false}
  }, {
    "name": "pebby:latest",
    "sizeBytes": 12345,
    "parameterSize": "3.2K",
    "quantization": "F32",
    "modifiedAt": "2026-09-11T07:22:00Z",
    "chatUnavailableReason": "This model does not support chat.",
    "ui": {"runtime": "pebby", "entry": "ui/index.html"},
    "capabilities": {"chat": false, "infer": true}
  }],
  "connected": true
}
```

`chatUnavailableReason` is explicitly `null` when the model name passes known
gateway restrictions and its runtime supports chat, or a user-facing reason
otherwise. Discovery keeps
cloud names and names outside the length/syntax limits visible; chat rejects them
using the same `ModelAdmission` policy before acquiring an inference slot. A null
reason does not prove available memory, model loading or model quality. Every
model explicitly reports `capabilities: {chat, infer}`. Ollama supports chat only;
HostAI manifests declare these contracts at runtime level with optional per-model
overrides. Omitting capabilities preserves legacy inference-only behavior.
`POST /api/chat` dispatches chat-capable HostAI models to `/hostai/chat` using
the shared request/chunk contract. `/api/infer` requires `infer: true`.
Guest eligibility requires an admitted model with chat or a usable custom UI,
so a custom-UI model does not need to support chat to be shared.

`ui` is `null` for a model with no declared interface, or `{"runtime":
"<id>", "entry": "ui/index.html"}` when its runtime declares one and the
admitted model supports inference. `entry` is
the manifest entry relative to the runtime origin, without its leading slash;
the frame's `src` is `/api/model-ui/<runtime>/<entry>`. See
[the model-UI contract](../docs/model-ui.md) for the manifest and asset rules.

Unavailable, timed-out, or malformed upstream metadata gives HTTP 200 with
`{"models":[],"connected":false}`. Missing optional descriptive model metadata is an empty
string; admission metadata always supplies a null or a reason. An available server with no models gives `connected:true` with an empty
list. Connectivity is determined independently on each metadata request, per
configured runtime.

### `GET /api/requests`

```json
{
  "requests": [{
    "id": "868fc77a-4dc2-40d1-8be6-58821056c7b0",
    "model": "example:latest",
    "status": "running",
    "startedAt": "2026-09-01T12:00:00Z",
    "durationMs": null,
    "outputTokens": null
  }]
}
```

Newest admitted first, maximum 50 entries. Status is `running`, `completed`,
`failed`, or `cancelled`. Running requests have null duration/tokens. Terminal
duration is elapsed monotonic time in milliseconds. Tokens come from Ollama's
final `eval_count`, or remain null if absent, cancelled, or failed. History stores
only these fields, never messages, prompts, responses, or upstream error bodies.
A long-running entry can age out after 50 newer admissions while still occupying
its inference slot.

### Local model downloads

`GET /api/model-downloads` returns `{"downloads":[Job]}`, newest admitted first.
`POST /api/model-downloads` requires `Content-Type: application/json` and
`{"requestId":"<UUID>","model":"model:tag"}`. A new job returns HTTP 202.
Repeating a retained ID with the same model returns the current job with HTTP
200, including terminal jobs; reusing that ID with a different model returns
409. A distinct start while another pull is running also returns 409. There is
one global download slot, separate from the two chat slots, and no queue.

`POST /api/model-downloads/<UUID>/cancel` requires JSON `{}` and returns the
job with HTTP 200. Cancelling any terminal job leaves it unchanged; an unknown
or evicted ID returns 404. Retrying a cancelled or failed pull requires a new
request ID. IDs must use the full hyphenated UUID representation.

Every job includes every field below, including explicit null values:

```json
{
  "id": "868fc77a-4dc2-40d1-8be6-58821056c7b0",
  "model": "example:small",
  "state": "running",
  "phase": "starting",
  "message": "Starting model download.",
  "digest": null,
  "completedBytes": null,
  "totalBytes": null,
  "createdAt": "2026-09-01T12:00:00Z",
  "updatedAt": "2026-09-01T12:00:00Z",
  "error": null
}
```

`state` is `running`, `completed`, `failed`, or `cancelled`; `phase` is
`starting`, `downloading`, `verifying`, or `finalizing`. Timestamps are ISO
instants. Manifest discovery, layer download, digest verification, and manifest
writing map to these phases with fixed messages. An unknown nonblank ongoing
status uses `downloading` and `Downloading model.`; upstream status and error
text are never echoed. Terminal cancellation/failure retains the last phase.

Progress describes the current layer, never an aggregate percentage. Counts are
nullable, nonnegative 64-bit integers; completed cannot exceed total when both
are known. Missing completed is valid. A new digest clears previous counts;
subsequent omitted counts retain the last known values for that same layer.
Unknown totals remain null. Completing a job does not invent missing counts.
Only an explicit Ollama `status: "success"` completes a download. Premature EOF,
invalid/oversized records, upstream errors, and expired deadlines fail the job
with a fixed, sanitized error message. Each NDJSON record is capped at 256 KiB.

Pull names must be at most 128 characters and explicitly tagged:
`model:tag` or `namespace/model:tag`. Repository names are lowercase ASCII
letters/digits with `.`, `_`, or `-`; namespaces allow lowercase letters/digits
separated by single `_` or `-`; tags allow ASCII letters/digits, `.`, `_`, `-`.
Each component starts with a letter/digit. The download policy also applies
`ModelAdmission` and rejects missing tags, schemes, custom registry hosts/ports,
`localhost` namespaces, traversal (`..`), and known cloud model/tag suffixes.
The gateway posts exactly `{"model":"...","stream":true}` to the configured,
pinned loopback `/api/pull`, with no insecure flag, redirects, or automatic retry.

The admitted job owns the upstream subscription. Browser disconnects and
navigation do not cancel it. Explicit cancellation and service shutdown dispose
the exchange, including cancellation racing with subscription attachment or a
terminal callback. Cancellation closes this client's exchange; it cannot
guarantee that an independently running Ollama process stops shared work or
deletes partially cached layers. There is no resume/delete/installation-management
API. History and idempotency cover only the 20 most recently admitted jobs and
reset on restart. Evicted IDs may be admitted again.

Download deadlines are independent of chat: connection timeout 2 seconds,
first-record/idle timeout 5 minutes, overall timeout 2 hours. Tests can override
`hostai.download-connect-timeout`, `hostai.download-idle-timeout`, and
`hostai.download-overall-timeout` with positive durations. The transport also
bounds silent reads, and the overall deadline applies even while records arrive.

The Java boundary rejects Host names other than `127.0.0.1`, `localhost`, or `[::1]`,
including a DNS-rebound request whose Origin matches an attacker Host. This does
not authenticate local processes. Both management POST routes enforce JSON (415 otherwise).
An `Origin` header must match the request's exact scheme, host, and effective
port; another localhost port or hostname is not granted access. Cross-origin,
opaque/multiple origins and cross-site Fetch Metadata are denied with 403,
before a pull is admitted. No Origin is accepted for a trusted local proxy or
CLI. A browser-facing proxy must perform its own origin check before stripping
incoming browser Origin/Fetch Metadata headers on its Java request. No CORS
origins are granted. These checks keep the existing loopback foundation; they
do not add authentication or remote sharing. Download responses use
`Cache-Control: no-store`.

### `POST /api/chat`

Request: `Content-Type: application/json`; response:
`Content-Type: application/x-ndjson`. All four request fields are required.

```json
{
  "model": "example:latest",
  "messages": [{"role": "user", "content": "Hello"}],
  "temperature": 0.7,
  "maxTokens": 256
}
```

| Input | Limit |
| --- | --- |
| Entire JSON body | 262144 bytes (256 KiB) |
| Model | 1–128 characters; starts with an ASCII letter/digit; remaining characters are letters/digits or `._:/-` |
| Messages | 1–64 non-null entries |
| Role | `user`, `assistant`, or `system` |
| Content | Nonblank; at most 16384 Java string characters per message |
| Combined content | At most 65536 Java string characters |
| Temperature | Finite number between 0 and 2 inclusive |
| maxTokens | Integer from 1 to 8192 inclusive |

Unknown request properties and fractional `maxTokens` are rejected. The proxy
sends the model and messages unchanged, `stream:true`, and
`options:{"temperature":...,"num_predict":...}` to Ollama `/api/chat`. There are
no generation retries.

Each response record is one complete JSON value followed by a newline:

```ndjson
{"content":"Hello","done":false}
{"content":"!","done":true,"outputTokens":7}
```

Concatenate `content` from **every** record, including the final one. Stop on
`done:true`. `outputTokens` is optional and appears only when Ollama supplies a
final count. Internal thinking/tool-call fields are not forwarded. Empty content
chunks are valid. Do not equate a TCP chunk with an NDJSON record: retain partial
lines and decode UTF-8 incrementally.

If Ollama fails after streaming starts, the final record is explicit:

```ndjson
{"content":"","done":true,"error":"Ollama reported a generation error."}
```

HTTP status remains 200 after commitment. A stream ending without Ollama's
`done:true`, an invalid/oversized record, or a timeout is treated as failure.
If the downstream socket has already disappeared, delivering an error record is
impossible; the request is cancelled and its slot is released instead.

### `POST /api/infer`

Opaque inference for a model with a HostAI-runtime interface, described in
[the model-UI contract](../docs/model-ui.md). Request: `Content-Type:
application/json`; response: `Content-Type: application/x-ndjson`.

```json
{"model": "pebby:latest", "input": {"board": [[0, 1]], "action": "up"}}
```

`model` is 1–128 characters and follows the same name rules as chat's `model`
field. `input` is any JSON value; the gateway never interprets it. Unknown
request properties are rejected, and the entire body is capped at 262144 bytes
(256 KiB), the same limit as chat.

This endpoint shares the two inference slots and the `/api/requests` history
with `/api/chat`; a history entry from `/api/infer` always has a null
`outputTokens`. Each response record is one complete JSON value followed by a
newline:

```ndjson
{"event":{"score":3},"done":false}
{"done":true}
```

`done` is always present. `event` is present only when the runtime supplied
one for that record; the final record may carry an `event`, or may be a bare
`{"done":true}`, or, on failure after streaming started, `{"done":true,
"error":"..."}`. The error string is at most 256 characters, with control
characters removed, taken from the runtime's own terminal record.

Before any record is emitted, failures are `application/problem+json` using
the same status table as chat (below), with these specifics for inference:

- The runtime answers `400` with `{"error":"..."}`: the gateway forwards that
  message (sanitized, at most 256 characters) with HTTP 400.
- The runtime answers any other non-2xx status: HTTP 502, "The runtime
  rejected the inference request."
- The runtime is unreachable: HTTP 503.
- The runtime answers `200` with a single `application/json` value instead of
  NDJSON: the gateway emits it as one record, `{"event": <value>, "done":
  true}`.
- The model is served by the Ollama runtime, which has no inference protocol:
  HTTP 400, "This model only supports chat."

Headers are the same as chat: `Cache-Control: no-store`, `X-Accel-Buffering: no`.

### `GET /api/model-ui/{runtime}/{path}`

Proxies one static asset from a runtime's declared UI, or the gateway's own
bridge script. `{runtime}` must match `^[a-z0-9][a-z0-9-]{0,31}$` and name a
runtime present in the current catalog read. `{path}` is 1–8 `/`-separated
segments matching `[A-Za-z0-9._-]+`, with no `.` or `..` segment and no query
string.

The last path segment must end in an allow-listed extension: `html`, `js`,
`mjs`, `css`, `json`, `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`,
`woff`, `woff2`, `wasm`, `txt`, `map`. The gateway sets the response's content
type from this extension, ignoring whatever the runtime sent; `html`, `js`,
`mjs`, `css`, and `txt` get `charset=utf-8`, and `map` is served as
`application/json`.

A path whose last segment is `hostai-bridge.js` is always answered from the
gateway's own classpath resource `hostai/hostai-bridge.js`, never proxied to
the runtime. Any other path must start with the UI root — the directory
containing the runtime's manifest `entry` — or the gateway returns 404
without contacting the runtime. Otherwise the gateway requests `/{path}` from
the runtime: a runtime `404` becomes a gateway `404`; any other runtime
failure becomes `502`; an asset larger than 8 MiB becomes `502`.

An unknown runtime, an invalid path, or a disallowed extension is `404`
`application/problem+json`.

Every response carries `Cache-Control: no-store`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, and the model-UI
Content-Security-Policy from [the model-UI contract](../docs/model-ui.md),
with `<origin>` set to `scheme://Host` of this request. The web app's proxy
replaces that origin with its own browser-facing origin before the response
reaches the browser. There is no `X-Frame-Options`, since the host page must
be able to frame this asset.

### Errors and concurrency

Before any record is emitted, errors are HTTP `application/problem+json`
responses using Spring `ProblemDetail`. Clients must inspect HTTP status before
starting their NDJSON parser. This table covers both `/api/chat` and
`/api/infer`; see the `POST /api/infer` section above for its runtime-specific
400/502/503 cases.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, unavailable local model, or the runtime rejecting the input |
| 413 | Input body exceeds the byte limit |
| 429 | Both inference slots are occupied; `Retry-After: 1`; no upstream generation starts |
| 503 | Runtime unreachable/unavailable, or upstream overload, before the first record |
| 502 | Upstream failure, malformed response, or premature EOF before the first record |
| 504 | Upstream timeout before the first record |

Two slots cover the complete admitted lifecycle, including waiting for upstream
headers. There is no waiting queue. Completion, error, and cancellation release
the lease exactly once. A validated `done:true` record marks inference completed
before it is delivered downstream, so a client stopping at that record preserves
the completed history entry and token count. A disconnect before that record is
cancelled. WebFlux propagates downstream cancellation to the
upstream HTTP subscription, which closes that exchange's dedicated connection;
there is no detached inference task. Controllers and stream processing use Java
virtual threads; Reactor Netty transport uses event-loop threads. Backpressure
limits stream prefetch to one decoded record; each upstream JSON value is capped
at 256 KiB.

Connect timeout is 2 seconds; metadata requests time out after 3 seconds. Chat
and inference share the same idle/first-record timeout of 60 seconds and total
generation time of 10 minutes.
The idle window measures stream progress: either a silent runtime or a stalled
consumer can exhaust it. This bounds slot retention under downstream backpressure.
Tests shorten these with `hostai.metadata-timeout`, `hostai.stream-idle-timeout`,
and `hostai.generation-timeout`. An unreachable process can produce 503 before
streaming; a listening but stalled process can instead produce 504.

### Health and frontend integration

`GET /actuator/health` is the only exposed actuator endpoint and returns minimal
backend health, with no component details. It does not claim Ollama is online;
use `/api/status` for that distinction.

No CORS origins are granted. Both the browser and Electron renderer must use the
shared TanStack Start application's **same-origin server proxy** for `/api/*`.
That proxy should target `http://127.0.0.1:8080`, stream the response without
buffering, preserve HTTP status/content type, and abort its upstream fetch when
the browser aborts. Do not call the backend directly from a `file://` renderer or
add wildcard CORS. HostAI sends `Cache-Control: no-store` and
`X-Accel-Buffering: no` on chat responses.

Keep the owner API and workspace on loopback: local processes can call them
without credentials. The managed Quick Tunnel exposes only the independent guest
listener, with channel-bound keys and reachability checks. Do not tunnel the owner
API or Ollama directly. Tests make no inference-quality or real-model performance
claims; provider and lifecycle evidence is recorded in the verification guide.

### Guest listener additions

The guest listener (see [guest access](../docs/guest-access.md) for the full
contract) gained the same model-UI and opaque-inference surface as the owner
API.

`GET /guest/v1/session` gains a `ui` field with the same shape as a model
record's `ui`: `null`, or `{"runtime", "entry"}` for the shared model.

`POST /guest/v1/infer` mirrors `/guest/v1/chat`: the bearer key is checked
before the body is read, `Content-Type: application/json` is required (415
otherwise), and the body is `{"model", "input"}`. On the internet channel it
returns 409, "Public inference requires WebSocket transport at
`/guest/v1/chat-stream`."; clients must use the WebSocket there. Otherwise it
applies the same guest rules as chat: one inference slot per key, 6 requests
per minute, and the key's granted model only. Records are the same NDJSON
infer records as `/api/infer`.

The `/guest/v1/chat-stream` WebSocket's first message may be `{"key": "...",
"infer": {"model": "...", "input": <json>}}` instead of `{"key": "...",
"request": <chat request>}` — still exactly two top-level properties. Once
that message selects inference, every subsequent frame is an infer record; a
terminal error after streaming started is `{"done": true, "error": "..."}`.

`GET /guest/v1/model-ui/{runtime}/{path}` follows the same path, extension,
and header rules as the owner route, with no key: the sandboxed frame loads it
with a plain request. It answers only while guest access is currently running
for a model whose `ui.runtime` equals `{runtime}`; otherwise 404. The
Content-Security-Policy origin is this listener's own browser-facing origin —
`http://<Host header>` on the local channel, the Quick Tunnel origin on the
internet channel. These guest responses omit both `X-Frame-Options` and
`Cross-Origin-Resource-Policy`, unlike the listener's other responses. The
guest page's own Content-Security-Policy gained `frame-src 'self'`.

## Tests

```sh
cd backend
JAVA_HOME=/usr/lib/jvm/java-26-openjdk ./mvnw test
```

`BackendHttpTest` binds an isolated Ollama HTTP stub to an ephemeral **loopback**
port and injects that origin before Spring starts. The backend also uses an
ephemeral test port. No test contacts port 11434, starts Ollama, or downloads or
runs any model. The HTTP suite covers metadata conversion, offline errors,
forwarding, streamed content/tokens, limits, overload, cancellation before headers
and during a silent stream, upstream socket closure, malformed/truncated streams,
timeouts, absence of generation retries, history privacy, CORS, and actuator
exposure. Every client, stub server, and stub event loop is closed after use;
Spring's test context is closed after the class.

`ModelDownloadHttpTest` uses a separate ephemeral loopback runtime stub and
backend to cover the download API, streamed layer progress, idempotency,
concurrent starts, browser disconnects, cancellation/socket closure/retry,
strict input and browser-header rejection, failure streams, and history
eviction. `ModelDownloadLifecycleTest` uses loopback runtime exchanges with
subscription gates and cached HTTP response replays to exercise synchronous
termination, late subscription attachment, 100 terminal/cancel/shutdown races,
and shortened idle/overall deadlines. Both suites close their exact runtime
servers, clients, event loops, and executors. They never contact the real
Ollama port or download a model. A sandbox which denies loopback socket creation
cannot run these integration/lifecycle checks; compiling them is not evidence
that they pass.

`ChatServiceTest` exercises real gateway decoding with an in-memory HTTP exchange,
including cancellation synchronously on the final record. It verifies that this
preserves completion and tokens, while earlier cancellation and terminal errors
retain their respective states. It does not use a network socket or run inference.

`ModelUiHttpTest` runs a HostAI-protocol stub built on
`com.sun.net.httpserver.HttpServer` alongside an Ollama stub, both on ephemeral
loopback ports, to cover the mixed-runtime catalog merge, `/api/infer`
streaming and its runtime-specific error mapping, `/api/model-ui` asset-proxy
validation and headers, the bridge script, and guest infer/session/model-ui
gating on the local channel. `ModelUiSocketTest` reuses both stubs with a
directly started internet-channel listener to cover the WebSocket's `infer`
envelope, malformed envelopes, and the model-UI route behind the tunnel origin.
Both suites close their exact stub servers, clients, and loops.

For a dependency-free subset using the installed JDK:

```sh
JAVA_HOME=/usr/lib/jvm/java-26-openjdk ./scripts/test-core.sh
```

This runs the same core checks used by `CoreTest`: strict loopback validation,
two-slot admission, terminal counters, history eviction, and 200 races between
completion/failure/cancellation on virtual threads. It **does not** compile or
verify Spring integration or HTTP cancellation. Passing that subset must not be
reported as passing the full backend suite.

Official references: [Spring virtual-thread execution](https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html),
[Ollama chat contract](https://docs.ollama.com/api/chat),
[Ollama model metadata](https://docs.ollama.com/api/tags),
[Apache Maven Wrapper](https://maven.apache.org/tools/wrapper/).
