# HostAI

A local inference workspace with one frontend for **Electron and your browser**, backed by Java. Connect an existing Ollama runtime, download a local model, stream conversations, and inspect request activity.

This is a working local foundation. **Authentication, API keys, internet tunnels, persistent history, signed installers, and bundled Java runtimes are not implemented.** Both servers bind to loopback; do not publish this version to the internet. Runtime and request metrics come from the backend, never sample data.

## Stack

- pnpm 11 workspace
- Vite+ 0.3.1, TanStack Start 1.168.50, React 19.2.8, TypeScript 7.0.2
- Panda CSS 1.12.1 with local fonts and shared design tokens
- Electron 44.3.0; sandboxed renderer with no Node integration or preload bridge
- Java 26, Spring Boot 4.1.1, Spring WebFlux, Jackson 3, virtual-thread execution
- Maven Wrapper 3.3.4 / Maven 3.9.12

## Run

Requirements: Node 24+, pnpm, JDK 26, and `curl` for the first Maven download. The source launch scripts target Linux/macOS; Linux is verified. Install Ollama separately if you want real inference. No command in this repository installs or downloads models automatically.

```sh
pnpm install
pnpm desktop:dev
```

The desktop launcher starts the Java gateway, starts Vite+, then opens Electron. The same UI is available at **http://127.0.0.1:3000** while the app runs. Use **Workspace → Open in browser** from Electron's menu. Closing Electron stops the services owned by that launcher; it does not stop your Ollama process.

The launcher honours `JAVA_HOME`. On this Linux machine it can discover `/usr/lib/jvm/java-26-openjdk` without changing the global Java installation. Elsewhere, select your JDK explicitly:

```sh
export JAVA_HOME=/path/to/jdk-26
pnpm desktop:dev
```

For browser development, use two terminals:

```sh
pnpm backend:dev
pnpm dev
```

Open http://127.0.0.1:3000. You can develop the frontend without starting Java; it shows an offline state and setup instructions.

To run built assets instead of a development server:

```sh
pnpm build:all
pnpm desktop:start  # Electron + localhost UI + Java
# or
pnpm start          # localhost UI + Java, no desktop window
```

The combined launchers require ports 3000 and 8080 to be free. They refuse to reuse an unknown process on either port. Use Ctrl+C to stop browser mode. Linux development uses Chromium's user-namespace sandbox; unprivileged user namespaces must be available. The launcher does not disable renderer sandboxing.

For a machine without a usable GPU, launch with `HOSTAI_SOFTWARE_RENDERING=1 pnpm desktop:start` (or `desktop:dev`).

## Connect a model

Start Ollama, then open **Models → Download a model**. Enter an explicit library tag such as `qwen3:0.6b`, check its requirements using the library link, and explicitly start the download. HostAI shows current-layer progress, cancellation and retry; completion refreshes the library and offers **Try downloaded model**. Terminal downloads with Ollama also appear after refresh. Default Ollama origin: `http://127.0.0.1:11434`.

```sh
HOSTAI_OLLAMA_URL=http://127.0.0.1:11435 pnpm desktop:dev
```

Keep Ollama configured for local inference. A different loopback port is allowed; arbitrary remote origins are rejected. Downloading a model and actually running it consume disk, memory, and compute. Tests use isolated HTTP stubs and never contact the default Ollama port.

## Architecture

```text
Electron window ─┐
                 ├─ http://127.0.0.1:3000 (TanStack Start)
Browser tab ─────┘           │ same-origin streaming proxy
                            ▼
                  127.0.0.1:8080 (Java gateway)
                            │ bounded concurrency, validation
                            ▼
                  127.0.0.1:11434 (your Ollama runtime)
```

Electron contains window/menu handling only. All UI components and styling live in `apps/web`. The Start proxy is an allowlisted server route, used in both dev and production. Cancelling a browser request propagates through the proxy and closes the upstream Java/Ollama stream.

The backend allows two concurrent generations and rejects overload with HTTP 429; the frontend proxy preserves its `Retry-After` header. It does not queue requests yet. It retains the latest 50 request metadata records in memory. Conversations stay in the current playground tab and clear on navigation. Streaming uses NDJSON, not the OpenAI API contract. See [the backend contract](backend/README.md).

Interrupted answers remain visible with an exclusion label. Later prompts reuse
recent user messages and completed, nonblank answers; unfinished or empty answers
are not sent back as model context. The playground keeps the newest whole turns
that fit the gateway's message, character, and serialized upload limits. Before
Send, it discloses how many older turns will be omitted, including when only the
new message fits. Your new message and visible transcript remain intact; each
sent message records its omission count. These are request limits, not a model's
token window. Oversized new messages remain editable with a visible error until
you shorten them. The conversation keeps its selected model if discovery changes.
Switching models or clearing the conversation starts fresh.

Streaming follows the latest output until you scroll back to read. Use
**Jump to latest**, scroll back to the bottom, or send a new prompt to resume.
Keyboard users can focus the conversation pane and use its native scroll keys.
Automatic scrolling stays inside that pane and preserves the surrounding page.

Assistant answers support Markdown headings, lists, tables, and scrollable code
blocks. Copy response preserves the original Markdown; Copy code copies the
current block. Interrupted output is labeled Copy partial response and stays
excluded from later prompts. Raw HTML displays as text and images display their
alt text without downloading anything. Credential-free HTTPS links open separately
(in the system browser on desktop). Code uses plain monospace without highlighting.

Model discovery keeps unavailable entries visible with the gateway's reason.
The playground defaults to a model that passes known gateway rules and blocks
unsupported selections before Send. Availability changing on refresh preserves
the selected conversation. This does not probe model capabilities or memory.
After updating the web app, restart the updated Java gateway too: missing
admission metadata is shown as unknown and cannot enable generation.

The frontend proxy accepts at most 256 KiB per chat upload and allows ten seconds to receive it. On early rejection, the production server sends the complete error response, then discards at most another 1 MiB for up to 250 ms before closing the connection. This gives clients still uploading a chance to receive the error. Metadata and download-management requests time out after ten seconds. Download jobs continue independently of those requests and page navigation. Chats have a 610-second proxy deadline, giving Java's default ten-minute generation limit time to return an explicit error. If you override Java's generation timeout, keep it below the proxy deadline. The browser finishes on the first `done:true` record and releases the response stream.

Download jobs run one at a time and retain only the latest 20 records in memory.
A gateway restart clears the records and stops its active request; Ollama keeps
model files and may retain partial layers. Cancellation stops this gateway’s
request, not a download another Ollama client also requested. There is no catalog
search, disk/RAM fit estimate, automatic download resumption or public sharing.

## Checks

```sh
pnpm check          # TypeScript, Vite+ lint and formatting
pnpm test           # Stream protocol and server proxy tests
pnpm build && pnpm test:http # Built server, real sockets, isolated backend stub
pnpm backend:test   # Java tests; isolated HTTP runtime stub
pnpm test:ui        # Requires a running frontend and the Linux tools below
```

UI checks require Sway 1.12, bubblewrap, grim, wtype, wl-clipboard, Chromium, Python, and `/usr/bin/node`. The runner verifies a private headless software display before opening a browser or Electron, and cleans up its processes and temporary directory. It never uses an inherited desktop socket. See [verification details](docs/verification.md).

## Compatibility note

The current TanStack Start/Vite+ combination rejects an otherwise usable SSR environment through an `instanceof` check. A small **version-pinned pnpm patch** in `patches/` checks the required `runner.import` method instead. `pnpm install` applies it reproducibly. See [upstream issue #7614](https://github.com/TanStack/router/issues/7614). Reassess the patch when upgrading Start.

The `vite` peer-version warning is caused by the Vite+ alias exposing version `0.3.1` while Vitest expects Vite's version range. The project uses the single Vite+ implementation and its bundled Vitest; dev, build, and tests are checked together.


The [host and client journey audit](docs/user-journeys.md) records current UX gaps
and the path from local downloads to safe sharing, host discovery and remote chat. Those
remote capabilities remain unimplemented; the audit is not a deployment guide.
