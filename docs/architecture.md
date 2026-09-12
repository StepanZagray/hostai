# Architecture overview

HostAI is a local workspace: the browser or Electron window talks to a Java
gateway, and the gateway talks to a local inference runtime. The owner UI,
guest UI, runtime protocol and HTTP details are documented separately in the
[backend contract](../backend/README.md), [guest access guide](guest-access.md)
and [model UI protocol](model-ui.md).

## Request topology

```text
Electron window ─┐
                 ├─ http://127.0.0.1:3000 (TanStack Start)
Browser tab ─────┘           │ same-origin streaming proxy
                            ▼
                  127.0.0.1:8080 (Java gateway)
                            │ bounded concurrency, validation
                            ▼
                  127.0.0.1:11434 (your Ollama runtime
                  or any HostAI-protocol runtime)
```

Electron contains window and menu handling only. UI components and styling
live in `apps/web`. The Start proxy is an allowlisted server route used in
development and production. Cancelling a browser request propagates through
the proxy and closes the upstream Java/runtime stream.

The same proxy forwards `POST /api/infer`, the opaque inference route for
HostAI-protocol runtimes, and `GET /api/model-ui/{runtime}/{path}` for a
runtime's interface files. Model UI responses use `Cache-Control: no-store` and
a model-UI Content-Security-Policy. The page runs in an
`iframe sandbox="allow-scripts"` with an opaque origin, no network, no storage,
and only the gateway-served bridge script to reach HostAI.

## Ownership and lifecycle

The backend permits two concurrent generations and rejects overload with HTTP
429; it does not queue requests. The frontend proxy preserves the upstream
`Retry-After` header. The backend retains the latest 50 request metadata
records in memory. Streaming uses NDJSON, not the OpenAI API contract. The
[backend contract](../backend/README.md) is the source of truth for endpoint
schemas and limits.

For owner conversation state, download lifecycle and UI recovery, see
[Using models](using-models.md). For guest-specific listeners, credentials,
tunnel lifecycle and limits, see [Guest access](guest-access.md).

## Request boundaries

The frontend proxy accepts at most 256 KiB per chat upload and allows ten
seconds to receive it. On early rejection, the production server sends the
complete error response, then discards at most another 1 MiB for up to 250 ms
before closing the connection, giving clients still uploading a chance to
receive the error. Metadata and download-management requests time out after
ten seconds.

Download jobs continue independently of metadata requests and page navigation.
Chats have a 610-second proxy deadline, giving Java's default ten-minute
generation limit time to return an explicit error. If Java's generation timeout
is overridden, keep it below the proxy deadline. The browser finishes on the
first `done: true` record and releases the response stream.

For dated implementation evidence and isolated test details, see
[Verification](verification.md).
