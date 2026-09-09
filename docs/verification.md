# Verification

Backend tests run against an ephemeral loopback HTTP stub. They cover discovery, input validation, oversized bodies, health exposure, overload, streaming errors, timeouts, socket closure, and cancellation. Core checks include 200 competing terminal-state transitions. These results do not measure model quality or GPU performance.

`pnpm test` verifies fragmented NDJSON/UTF-8 decoding, immediate completion at the terminal record, invalid records, truncated streams, midstream failures, and HTTP errors. Proxy tests cover the method/path allowlist, origin and media-type checks, bounded byte-counted uploads, cancellation, overload headers, streaming, and cleanup. Fake timers verify upload and chat deadlines without waiting for a long generation. These tests stub fetch and do not exercise real network cancellation; the Java and full integration suites cover that separately.

Browser scenarios cover offline setup, filtering models, streamed conversations, errors, and responsive navigation at 320/768/1024/1440 pixels. Completed and overloaded playground screenshots are retained in `test-results/`. The Electron smoke test opens the actual shared app and checks navigation and absence of Node integration in the renderer.

Refresh tests cover all combinations of endpoint failure, unavailable versus empty
model discovery, cancellation, and recovery. Browser checks verify that a failed
history refresh leaves chat usable, failed status/discovery cannot claim readiness,
and keyboard retry restores the affected view. Partial-refresh and unavailable-model
screenshots are retained with the other UI evidence.

Conversation tests distinguish visible turns from outgoing context. They cover
interrupted/empty answers, preservation of user prompts and completed exchanges,
model changes, and Clear. The full Java integration scenario verifies follow-up
context after cancellation; browser interception separately tests cancellation
before headers, truncated responses, and duplicate submission. None run a model.

Context-budget tests check exact gateway boundaries: 64 messages, 16,384 UTF-16
units per message, 65,536 combined units, and 262,144 serialized UTF-8 bytes.
They cover whole-turn removal, contiguous recent history, JSON escape expansion,
Unicode preservation, and invalid new prompts. An isolated browser scenario
checks omission disclosure before Send, the actual outgoing context, retention
of the full transcript and sent-message annotation, mobile wrapping, and Clear.
Context-limit screenshots are retained in `test-results/`. These tests do not
measure token counts or a real model's context capacity. A separate browser check
inserts an oversized new prompt, confirms it remains intact with a validation
error, blocks Enter submission, and sends successfully after the user shortens it.
The error state is captured in `test-results/prompt-too-long.png`.

`pnpm build && pnpm test:http` launches the built Node/Start server and an HTTP backend stub on ephemeral loopback ports. It verifies byte-preserving forwarding and real 413/504 responses for oversized or stalled uploads, then checks that the server still handles another request. This catches incoming-socket teardown bugs that mocked Fetch streams cannot reproduce. Both processes and all sockets are closed afterward. CI runs this suite after building; it needs no display or Java service.

Model admission checks compare discovery reasons with request validation at name
length/syntax/cloud boundaries. Real HTTP tests verify restricted names remain
visible but cannot contact inference. Browser checks cover mixed libraries,
allowed defaults, direct unsupported selections, all-unavailable libraries,
missing metadata, and preservation of a conversation after a policy change.
The Java integration fixture includes a cloud entry before the local test model:
the UI must display its restriction, choose the local default, then stream and
cancel through the real gateway. All inference responses remain fixture data.
Evidence includes `test-results/models-admission.png` and
`test-results/playground-admission.png`.

Scrolling scenarios use a browser-local controlled `ReadableStream` to place
chunks precisely around input and layout events. Native wheel and keyboard checks
cover reading above the newest output, Jump focus, follow-up submission, Clear,
model changes, page-position preservation, and viewport resize. A rapid synthetic
stream exercises native keyboard animation; its exact interval is cleared in
`finally`. Deterministic event-order checks combine wheel/keyboard/touch intent
with reflow before ResizeObserver can run. These validate Chromium behavior and
touch handlers, not native iOS/Safari. Scrolled-up, following, and mobile screenshots
are retained in `test-results/conversation-*.png` and
`test-results/mobile-conversation-reading.png`.

Answer checks cover Markdown structure, unfinished fences, escaped HTML, image
placeholders without remote requests, and the shared HTTPS URL policy. Browser
checks compare copied responses and follow-up context to the original Markdown,
verify code-only copying, failures, empty fences, partial answers, 320px horizontal
code scrolling, and asynchronous copy feedback after command changes. Evidence:
`test-results/formatted-answer.png`, `mobile-formatted-answer.png`, and
`narrow-code-answer.png`.

The Electron test focuses its exact window on the private compositor, activates
Copy command using `wtype`, then reads the private clipboard with `wl-paste`.
Native input is necessary to supply a Wayland selection serial. It also checks
that renderer clipboard reads remain denied; `electron-copy.png` captures the
result. Only the trusted local main frame can request clipboard writes. Tests do
not launch a real external browser or validate macOS clipboard behavior.

Renderer behavior follows [react-markdown](https://github.com/remarkjs/react-markdown)
with remark-gfm and no raw-HTML plugin. Permission names and callbacks follow
[Electron session documentation](https://www.electronjs.org/docs/latest/api/session).
The expensive answer renderer is memoized behind `useDeferredValue`. Incoming
text and copy state stay current while React can defer formatting under load.
The answer wrapper exposes `aria-busy` until it catches up. Each actual parse is
still synchronous; this does not eliminate large-document stalls.

Setup journey checks follow missing runtime → empty library → available model →
selected Playground. A connected gateway/runtime must not show commands to start
a second workspace; unavailable discovered models lead to their reasons before
another download. The browser address includes the actual port. Desktop and
mobile setup evidence is retained in `test-results/setup-*-journey*.png`.

## Rendering measurements

With a production build running on port 3001:

```sh
HOSTAI_TEST_URL=http://127.0.0.1:3001 HOSTAI_RENDER_BENCH=1 python3 scripts/test-ui.py --grep 'measure .* streaming rendering'
```

These opt-in diagnostics stream 16,000 ASCII characters in 1,000 chunks, nominally
10ms apart, from a fixture worker served on the same origin. Worker timestamps
record achieved cadence independently of the UI thread. The initial blob-worker
approach was rejected by production CSP; the fixture requires no policy change.
A single conversation follows output at 1440×1100, using Chromium's artificial
4× CPU slowdown and the isolated software renderer. Prose also goes through the
Markdown parser; it is a different content shape, not a parser-free baseline.

JSON artifacts `test-results/render-*-4x-*.json` record browser version, fixture
parameters, frame gaps, >50ms main-thread tasks, worker delivery delays and DOM
mutation batches. Mutation batches are not React commit counts. The fixture
checks whole-response copying against its exact source after measurement and
waits for deferred formatting to settle. Its clipboard is a test-local stub;
the separate Electron scenario checks the actual private clipboard.

Timing is diagnostic, not a hardware-dependent test gate or an inference benchmark.
Single-run differences are exploratory, not a guaranteed speedup across devices.
This does not measure INP, real network cancellation, deep conversation histories,
or arbitrary unbounded answers. All workers, observers, animation callbacks and
CDP sessions are disposed. The existing UI suite covers Stop, stream failures,
Clear, model changes and scrolling separately.

Sources: [React deferred rendering](https://react.dev/reference/react/useDeferredValue),
[Chromium CPU throttling](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate),
and [long-task timing](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming).

## Isolated UI runner

Start the frontend, then run `pnpm test:ui`. `scripts/test-ui.py`:

1. Requires the verified Sway 1.12 version; copies the binary without its system capabilities.
2. Uses a private mode-0700 runtime directory and an explicit environment.
3. Mounts private `/dev`, `/run`, `/tmp`, and `/proc` using bubblewrap. Physical DRM/input devices and live seat/session buses are unavailable.
4. Enables only wlroots' headless backend and pixman software renderer.
5. Checks the exact compositor PID, environment, descriptors, outputs, and startup logs before launching clients.
6. Gives Chromium/Electron only the private display. Captures the native window using `grim -o HEADLESS-1`.
7. Stops and waits for its exact process groups, including workers whose original parent exited, and verifies cleanup. Bubblewrap also kills children if its parent dies. Evidence is retained in ignored `test-results/`.

Official source used to establish the configuration: [Sway 1.12 server implementation](https://github.com/swaywm/sway/blob/1.12/sway/server.c). Updating the compositor version requires revalidating the guard; setting an unrecognised environment variable is not proof of isolation.

## Full Java → UI integration

Use separate terminals for the explicit fixture and Java service:

```sh
node apps/web/tests/support/ollama-stub.mjs
HOSTAI_OLLAMA_URL=http://127.0.0.1:11435 pnpm backend:dev
pnpm dev
HOSTAI_INTEGRATION=1 pnpm test:ui
```

The integration scenario waits for a real streamed chunk through Java and Start, cancels it, verifies zero occupied slots, and checks the `cancelled` history entry. The fixture is clearly named `test-model:small`; it is not a model and never loads in normal application mode.

For production-server verification:

```sh
pnpm build
HOSTAI_UI_PORT=3001 pnpm --filter @hostai/web start
HOSTAI_TEST_URL=http://127.0.0.1:3001 HOSTAI_INTEGRATION=1 pnpm test:ui
```

Stop the fixture, Java, and web servers with Ctrl+C when finished. The test runner owns only its compositor and UI clients; it does not kill existing app servers.

## Current limits

- Linux is the verified desktop platform. macOS source launch is unverified; Windows launchers/installers are not supplied.
- Distributable installers, signing, updates, and a bundled JRE remain future work.
- No inference benchmarks or actual-model generation were run during setup.
- Guest keys are stored durably; owner activity and conversations remain in memory. Optional Cloudflare Quick Tunnel sharing is temporary and does not provide verified host identity or a public directory.
- Production CSP allows inline scripts for Start's hydration bootstrap. The Electron renderer has no Node bridge. It allows clipboard writes only from the trusted local main frame; clipboard reads and other permission requests are denied.

## Local download lifecycle

On 9 September 2026, the tagged download-to-chat feature passed frontend
check/build, 106 unit/protocol tests, 5 real-server HTTP tests, and 71 Java tests.
The Java suite uses ephemeral loopback Ollama stubs and verifies explicit
success, current-layer resets/unknown counts, input/origin/Host rejection,
concurrent admission/idempotency, cancellation/disconnect/shutdown races, history
eviction and actual upstream closure on idle/overall deadlines. A continuously
streaming runtime reproduced an overall-deadline leak in both download and chat
before the fix; the corrected suite observes zero remaining upstream connections.

All 47 distinct ordinary UI/Electron/integration scenarios passed across the
broad run and focused follow-up. Two optional rendering benchmarks were skipped.
The broad run caught a scroll-test synchronization gap: a zero bottom distance
also matched an answer that had not rendered yet. The test now waits for actual
scrollable output before sending Home; all seven scroll scenarios passed three
successive runs. Two earlier old-title assertions were updated for the new
empty-library copy. These were not hidden with automatic test retries.

The real browser → production proxy → Java → isolated Ollama fixture journey
passed start, current-layer progress, navigation, explicit cancellation, retry
with a fresh ID, installed-model refresh, explicit selection and streamed chat.
The fixture listens only on 127.0.0.1:11435 and simulates `/api/pull`; it writes no
model files and makes no external requests. No real model was downloaded or run.
Fixtures also cover lost start responses, dismissal, malformed status, stale GET
responses arriving after cancellation, and recovery while last-known progress
remains visible. Progress/completion/mobile/recovery screenshots are retained in
`test-results/download-*.png`; isolated-display proof is `test-results/isolation.json`.

Downloads are intentionally one at a time with 20 in-memory records, no durable
resume, no catalog search or hardware fit estimate. This validation does not
prove performance or memory fit for real models. Authentication, internet sharing,
tunnels, a host directory and a remote client journey remain unimplemented.

## Guest access verification

Build the guest bundle before packaging or testing Java (`pnpm build`). The
separate bundle is embedded under `guest/` in the JAR. The guest page is served
by its own loopback listener, not the owner Node server.

The access-store suite checks hash-only persistence, canonical credentials,
exclusive locking in and across JVMs, permissions, symlinks, corrupt schemas,
atomic snapshots, bounded storage and poisoning after real write failures.
Guest HTTP tests exercise missing/duplicate keys, owner-route isolation, raw
Host/traversal requests, strict body limits, model scope, publication changes,
rate/concurrency limits, and revoke/stop closing the actual upstream socket.
Lifecycle tests add durable restart behavior, active expiry, failure before the
first record, storage-failure isolation and synchronous assembly cleanup. No
power-loss or fsync fault-injection result is claimed.

Guest browser fixtures exercise CSP and API separation, fragment scrubbing,
password entry, bounded connection timeout, streamed Markdown, Stop, reconnect,
expiry/revocation, draft retention, incomplete-context exclusion, request limits
and 320px layout. A real integration creates a grant through the owner UI, opens
its guest link, chats through Java, then revokes while the explicit fixture holds
its response. That fixture prompt never completes on its own; the test must end
it through revocation. No actual model or public endpoint is involved.

For this integration, set `HOSTAI_ACCESS_DIR` to a fresh temporary private path
when starting Java, and pass `HOSTAI_GUEST_TEST_URL=http://127.0.0.1:8081/` with
`HOSTAI_INTEGRATION=1` to the isolated UI runner. Enable the fixture model through
`/api/sharing/start` before running guest asset fixtures. Never run these tests
against the user's normal key store. Stop Java and remove the temporary store
after verification. The UI runner proves and owns only its private display and
clients, not the separately started Java, Node or Ollama fixture processes.

Evidence is retained in `test-results/guest-*.png`, `sharing-*.png` and
`isolation.json`. These checks do not establish external reachability, TLS,
verified identity, public abuse resistance, GPU reclamation or model quality.

## Temporary internet sharing verification

On 9 September 2026, the complete Java suite passed 377 tests. The final error-policy
adjustments passed 28 focused WebSocket tests, including one new case for losing
reachability before the first upload (378 distinct Java cases across these runs).
Frontend protocol tests passed 128 cases; typecheck/lint/format, production builds,
JAR packaging and five real-server HTTP checks passed. Socket tests also ran with
Netty paranoid leak detection. Inspection of the installed Spring 7.0.9 and Reactor
Netty 1.3.7 bytecode confirms synchronous inbound messages are borrowed: Spring
wraps without retaining and Netty releases after `onNext`. No extra release was added.
The final owner/guest/setup browser regression run passed 54 checks, including
the real local owner-to-guest integration and the public upload-timeout state.
Responsive sharing and recovery screenshots were visually inspected.

The scoped fixtures cover strict public Host/tag/origin checks, channel-bound keys,
upgrade and request limits, one generation per socket, timeout/error records,
disconnect before and during output, expiry, revocation and reachability loss.
Private TLS fixtures reject untrusted and wrong-host certificates, redirects,
ordinary HTTP responses, buffered records, malformed or mismatched proofs.
Process tests cover hostile output, startup/stop races, private configuration,
arguments treated as data, cleanup and a watchdog after an abrupt parent exit.
The watchdog test failed when its kill action was deliberately disabled, then
passed after restoration. Abrupt JVM death can still leave private scratch files;
only normal cleanup is claimed to remove them.

A real cloudflared 2026.9.0 Quick Tunnel, production Java guest listener and
isolated Ollama fixture completed public WSS chat with a 1,527 ms gap between
records. Actual public requests rejected missing/cross-channel keys and owner
routes. Revocation and client disconnect released inference admission; Stop
internet sharing cancelled generation and preserved local guest access. The
owned connector processes and private configuration were verified removed.

An isolated Chromium browser then exercised the actual public guest page with
native TLS, CSP and WebSockets: connect, partial and completed output, Stop,
draft-preserving retry, revocation, and reconnect rejecting the revoked key.
No CSP violation or credential in browser storage was observed. The isolated
display and its clients were removed. Evidence is retained in ignored
`test-results/internet-live-fixture.json` and `public-internet-browser.png`.
Only synthetic prompts/responses and disposable grants crossed Cloudflare; no
real model, user conversation, GPU benchmark or user access store was involved.

Earlier real-provider attempts were correctly blocked: new DNS names were not
yet resolvable, or HTTP NDJSON arrived buffered. A standalone real WSS proof
established incremental delivery before integrating the new transport. The first
real-browser attempt exposed the runner's hidden resolver-file symlink; test
clients now receive a read-only copy of DNS configuration while `/run`, devices
and service sockets remain private. A subsequent browser assertion expected raw
server error text, but the UI intentionally uses a sanitized reconnect message;
the corrected scenario also verifies the subsequent 401 and retained draft.

Cloudflare terminates TLS and can see relayed messages and keys. Quick Tunnels
are temporary development infrastructure, not a production uptime commitment.
This evidence does not establish verified identity, comprehensive public abuse
resistance, capacity under attack, model performance or a public host directory.
