# HostAI backend

Java 26, Spring Boot 4.1.1, Maven Wrapper 3.3.4 / Maven 3.9.11. No preview
features. This is an **unauthenticated localhost prototype**, bound to
`127.0.0.1:8080`. There is no tunnel, remote access, account system, or durable
database. Request history and counters live only in memory and reset on restart.

## Run

From this repository:

```sh
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
are disabled. HostAI never invokes Ollama's model pull/start endpoints or
downloads a model. A chat may cause Ollama to load an already installed model.
Known `:cloud` and `-cloud` model names are rejected. The operator must keep
Ollama itself configured for local inference; a gateway cannot enforce what an
independently configured upstream proxy does internally.

To build an executable JAR:

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
comes from a bounded `/api/version` probe; it does not mean a model is loaded.

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

Converts Ollama's `/api/tags`: `size` → `sizeBytes`,
`details.parameter_size` → `parameterSize`, `details.quantization_level` →
`quantization`, and `modified_at` → `modifiedAt`.

```json
{
  "models": [{
    "name": "example:latest",
    "sizeBytes": 5000000000,
    "parameterSize": "8B",
    "quantization": "Q4_K_M",
    "modifiedAt": "2026-09-01T12:00:00Z"
  }],
  "connected": true
}
```

Unavailable, timed-out, or malformed upstream metadata gives HTTP 200 with
`{"models":[],"connected":false}`. Missing optional model metadata is an empty
string. An available server with no models gives `connected:true` with an empty
list. Connectivity is determined independently on each metadata request.

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

### Errors and concurrency

Before any record is emitted, errors are HTTP `application/problem+json`
responses using Spring `ProblemDetail`. Clients must inspect HTTP status before
starting their NDJSON parser.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, unavailable local model, or Ollama rejecting the chat input |
| 413 | Input body exceeds the byte limit |
| 429 | Both inference slots are occupied; `Retry-After: 1`; no upstream generation starts |
| 503 | Ollama unreachable/unavailable, or upstream overload, before the first record |
| 502 | Upstream failure, malformed response, or premature EOF before the first record |
| 504 | Upstream timeout before the first record |

Two slots cover the complete admitted lifecycle, including waiting for upstream
headers. There is no waiting queue. Completion, error, and cancellation release
the lease exactly once. WebFlux propagates downstream cancellation to the
upstream HTTP subscription, which closes that exchange's dedicated connection;
there is no detached inference task. Controllers and stream processing use Java
virtual threads; Reactor Netty transport uses event-loop threads. Backpressure
limits stream prefetch to one decoded record; each upstream JSON value is capped
at 256 KiB.

Connect timeout is 2 seconds; metadata requests time out after 3 seconds. Chat
idle/first-record timeout is 60 seconds and total generation time is 10 minutes.
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

Do not expose this prototype through a public bind address, reverse proxy, or
tunnel. Local processes can call it without credentials. Authentication and
remote access are deferred work, and no inference-quality or real-model
performance claims are made by the tests.

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
