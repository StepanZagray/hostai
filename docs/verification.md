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

## Optional directory — 10 September 2026

The self-hostable directory is verified locally; no public registry was deployed.
The registry's 61 Node tests cover real loopback HTTP, exact signed audiences,
cross-registry relay rejection, nonce reuse without supersession or extension,
authenticated per-key admission, replay, expiry, bounded storage, OS locking and
failed commits. A fake-clock run exercised 100 hosts and readers for 17 simulated
minutes. This is admission verification, not a throughput or denial-of-service benchmark.

The full Java suite passed 475 tests. After the final identity interruption change,
118 focused directory tests passed following explicit recompilation, including
92 identity cases and actual Java publisher-to-Node registry interoperability.
Together with the final 30-test protocol/lifecycle run, these cover 500 distinct
Java tests. The final run also checks cross-site reads, bounded concurrent reads,
numeric TTL rules, changed model/label consent, capacity messages and uncertain
publication without an invented local-clock expiry.
The Java fixture exercises publish, heartbeat, withdrawal, changed tunnel consent,
restart and stable identity with the actual registry. The tunnel observation is
synthetic and does not establish real public endpoint availability.

Frontend type checking, lint, formatting and production builds passed, along with
150 unit tests and five built-server HTTP tests. The final isolated UI run passed
39 tests with no skips. It covers the configured directory through the actual
owner proxy/Java gateway/Node registry, standalone signed listing search/removal,
cross-site rejection, conservative expiry after browser resume, responsive and
failure states, setup recovery, guest streaming and revocation. It also checks
the corrected inference-diagram copy.

Visual evidence remains in ignored `test-results/directory-standalone.png`,
`directory-320.png`, `directory-1440.png`, `directory-owner-controls.png`,
`setup-ready-journey.png` and `guest-integration-revoked.png`. Tests used the private
Sway 1.12/pixman display and a synthetic Ollama fixture on 11435, with disposable
access/identity/registry storage. The exact fixture processes and private display
were stopped and their runtime directories removed. No real model download,
GPU workload, user conversation or default access store was used.

This verifies the reference discovery implementation and its consent/access
boundaries. Public deployment, guest-URL ownership, human identity, moderation,
in-app access requests and production abuse resistance were outside that directory-cycle
evidence. The subsequent access-request cycle is documented below.

Claude Opus 5 High reviewed the integration. Its actionable findings led to the
cross-site read checks, concurrent-read bound, replacement of expired entries at
capacity, numeric protocol coverage and clearer capacity feedback. Primary tests
verified the resulting changes; the review's earlier observations about pending
audience integration and unused clock arguments were already resolved locally.


## Access-request approval cycle

The complete backend suite passed 555 tests with Java 26 and offline Maven.
Frontend unit checks passed 279 tests; TypeScript, lint, formatting, the production
build and five built-server HTTP tests passed. Tests use private stores and synthetic
model metadata/streams; they do not establish model memory fit or GPU performance.

The 31 inbox tests and 12 request-flow tests cover canonical credentials,
content-idempotent retries, capacity, monotonic deadlines, independently bounded
anonymous/known/discovery traffic, owner duration selection, cancellation/approval
races, storage failures and rollback after tunnel replacement during approval.
The HTTP flow tests exercise a real private listener and store with explicitly
synthetic verified-tunnel observations. Existing grant, guest socket, sharing and
directory tests also ran in the full suite.

Seventy-four local browser regression scenarios passed across guest chat, sharing,
request recovery, directory controls, setup, model download/retry and owner chat.
The standalone directory's updated access explanation also passed against a real
private Node registry. All UI runs used the Sway 1.12/pixman/device-isolated runner;
its compositor/runtime cleanup was checked. No live desktop browser was used.

A separate public browser scenario passed through cloudflared 2026.9.0, using the
release asset verified against its published SHA-256 digest. It required a guest
request, explicit host selection of one hour, approval and an explicit Connect.
Connecting did not increment inference counts. The test streamed one completed
reply, waited for partial content and an active backend request on a second reply,
then revoked the key and verified the active count reached zero. Reconnect checked
metadata without inference and exposed revoked request status. Screenshots include
`access-requests-owner-320.png`, `access-requests-owner-1440.png`,
`access-requests-guest-pending-320.png`, `access-requests-guest-approved.png`,
`access-requests-guest-revoked.png`, `access-requests-guest-uncertain.png` and
`access-requests-owner-full-320.png` under `test-results/`.

One repeated public startup in a broader run failed DNS verification before any
guest request or inference. Its combined run therefore reported 74 passed / one
failed, while the separate public scenario passed. Do not interpret the successful
public run as an uptime guarantee: Quick Tunnel startup remains dependent on
external DNS and Cloudflare. The app kept public access blocked on that failure.

The public scenario now requires both `HOSTAI_INTEGRATION=1` and
`HOSTAI_PUBLIC_INTEGRATION=1`. A run without the latter was confirmed to skip the
public test and leave sharing stopped. Start only disposable services configured
with the synthetic Ollama fixture and private access storage before running it:

```sh
HOSTAI_INTEGRATION=1 HOSTAI_PUBLIC_INTEGRATION=1 \
  HOSTAI_GUEST_TEST_URL=http://127.0.0.1:8081 \
  pnpm test:ui access-requests-integration.spec.ts
```

It intentionally starts and stops a real public tunnel. Ordinary local regression
runs should omit `HOSTAI_PUBLIC_INTEGRATION`; an explicit test-name exclusion can
also avoid selecting the network scenario when matching `integration.spec.ts`.

Protocol details and operational limits are in [access requests](access-requests.md).
No public registry deployment, verified human identity, stable public hosting or
end-to-end encryption was added by this cycle.


## Guest onboarding presentation cycle

At this cycle, 279 frontend tests and 41 isolated browser scenarios passed, together
with TypeScript, lint, formatting and production builds. The guest bundle was
packaged into Java and served by a private gateway. Public guest origins and API
responses were intercepted browser fixtures; only built static assets reached the
private server. No public tunnel, real model download or inference was used.

The changed entry states were exercised at 320, 768, 1024 and 1440 pixels, including
keyboard expansion of the key alternative, initial focus, direct key fallback,
intake changes during key entry, request retry/cancellation, approval, disconnection,
expired access and retained drafts/transcripts. Existing guest tests cover actual
frontend stream parsing with controlled fixture chunks, cancellation and no automatic
resubmission. The disabled composer assertions for never-connected/disconnected
states now assert absence; tests with retained sessions still assert disabled Send.

A run exposed an existing test teardown race: a routed asset response was disposed
before its handler finished following reload. The fixture now waits for outstanding
route handlers before context disposal. The subsequent complete run passed all 41
scenarios. This was a fixture lifecycle correction, not an ignored failure.

Visual evidence includes `guest-onboarding-{320,768,1024,1440}.png`,
`guest-onboarding-invite-only.png`, `guest-onboarding-pending.png`,
`guest-onboarding-approved.png`, `access-requests-guest-uncertain.png` and
`guest-connected.png` under `test-results/`. The private Sway 1.12/pixman/device
isolation checks passed, and its exact compositor PID/runtime were absent afterward.
Claude Opus 5 High provided the focused read-only UX advice. The test services used
private storage and were stopped after verification.


## Owner prompt recovery and model-test handoff

The final run passed 279 frontend tests, TypeScript, lint, formatting, production
builds and 73 isolated browser scenarios. The shared context builder now excludes
both halves of failed, cancelled, streaming and empty completed exchanges. Its
existing character/byte/message boundary tests still pass; completed context remains
ordered and model-scoped, and excluded failed exchanges do not consume its budget.

Five owner recovery browser cases cover capacity rejection, network failure,
malformed records, truncated responses and an empty terminal response. They inspect
the edited request body, restored composer/focus and retained transcript at
320/768/1024/1440px. The sharing handoff checks that a completed response links to
the selected model and sends no sharing mutation. Existing guest, Markdown,
scrolling, model-admission and context-budget browser regressions also ran.

The real proxy/Java integration used the isolated Ollama stub: it completed one
response, cancelled another, checked active requests returned to zero, and verified
the following request omitted the cancelled question and answer. The separate
synthetic download scenario also passed cancel, retry, install confirmation and
chat with that exact model. No actual model files, GPU inference or public tunnel
were used. Backend implementation did not change; Java packaging was run with
tests skipped, and this cycle makes no new claim of a full backend test run.

The initial browser run had 37 passes and three failures. Two required updating an
old context expectation and a label locator; the third exposed Stop's reused button
becoming Send before the click completed once a draft was restored. Separate button
identities and preventing the Stop click's default action fixed the unintended
submission. The final suite asserts only one request exists after Stop until the
user explicitly sends again. All 73 scenarios passed after those corrections.

Evidence under `test-results/` includes `owner-recovery-*.png`,
`owner-model-tested.png` and `cancelled-conversation.png`. These were visually
inspected on the proved private Sway 1.12/pixman display. Its compositor/runtime
were removed; all private Java, Node and stub services were stopped after checks.
Claude Opus 5 High supplied the focused read-only advice. A model answering a
prompt is evidence for that conversation only, not a persistent readiness or
memory-fit assessment. Navigation/model switching cleared owner history at that
milestone; the following cycle adds retention within the tab.


## Per-model owner conversations in tab memory

The cycle passed 286 frontend tests, TypeScript, lint, formatting and production
builds. Seven store tests cover separate model drafts/settings/context, instance
isolation, prototype-like model names, cancellation before headers and after partial
output, late callbacks, completion winning a cancellation race, selected-only Clear
and pruning only untouched default sessions. Nothing serializes conversations into
browser storage; the router still stores scroll coordinates in session storage.

The final owner run passed 43 browser scenarios, alongside the three Java integration
scenarios described below. Browser verification covers retained conversations and drafts through
model changes, Models-to-Playground links and Connection navigation, scoped Clear,
no automatic submission, model disappearance/reappearance during metadata polling,
reload clearing work, 320px layout and keyboard focus after prompt recovery. The
existing owner recovery cases run at 320/768/1024/1440px. Markdown, scrolling,
context limits, admission and setup regressions are included.

Three real proxy/Java scenarios passed against the synthetic Ollama service:
completed/cancelled chat, cancel/retry/download confirmation followed by chat with
the installed fixture, and navigation during generation. The last checks active
requests return to zero, backend cancellation is recorded, partial text and draft
survive return, and no second request is admitted automatically. No actual model
files, GPU work or public tunnel were used. Java packaging succeeded with tests
skipped; this cycle makes no new claim of a full backend test run.

The initial browser storage assertion was too broad: the router legitimately
stores scroll coordinates. The corrected assertion permits only that key and
rejects conversation content. A repeat integration run reused the already-installed
fixture, invalidating its initial model count and download state; a fresh stub and
Java instance passed all three integration scenarios. A subsequent browser failure
exposed a real first-edit race before passive model selection. Selecting the visible
conversation in a layout effect fixes this before controls are painted.

Claude Opus 5 High provided advice and a separate read-only review. Its confirmed
focus finding was fixed: a different model's recovery counter must not steal focus
from the selector. The store compares prune settings with its actual defaults.
The suggested module singleton was rejected in favor of per-workspace ownership;
request serialization was inspected and does not spread internal conversation data.

Evidence is retained under `test-results/owner-memory/`, including restored desktop
and mobile conversations, missing-model recovery, return after cancellation, logs
and the private Sway 1.12/pixman isolation record. All test-owned Java, Node, Ollama-stub and advisor processes were stopped; the exact
compositor PID and private runtime were confirmed absent. Conversation persistence
across reloads and deletion undo remain unimplemented.


## Starter model acquisition

The final cycle passed 287 frontend tests in 15 files, TypeScript, lint, formatting,
production builds and 36 isolated browser scenarios (`downloads.spec.ts` and
`workspace.spec.ts`). The new data invariant validates distinct local tags and their
exact official listing URLs against the existing download validation rules.

Browser checks prove selecting a starter sends no POST; its exact tag reaches the
explicit start, completion refreshes discovered models, and the matching Playground
opens without a chat request. They also cover custom-tag metadata clearing, installed
model shortcuts, blocked admission, offline source/size information, uncertain-start
locking, unchanged retry credentials, keyboard focus and 320/768/1440px layouts.
Existing cancellation, stale status, failed-start and workspace regressions passed.
The first run had 34 passes and one test failure: it expected View setup where the
offline download form already offered Open setup. Correcting that locator, plus
adding the blocked-starter case, produced the final 36 passes.

The browser ran on the proved private Sway 1.12/pixman display against the built
Node app with intercepted API fixtures. These results do not establish real model
compatibility, quality, memory fit or download speed. The exact public model tag
pages and listed sizes were checked separately; see [source record](starter-models.md).
No model files, GPU work, Java integration or public tunnel were used this cycle.

Claude Opus 5 High supplied the bounded read-only advice. Visually inspected
screenshots include `model-choice-{320,768,1440}.png` and
`model-choice-installed.png`, retained with logs and isolation evidence under
`test-results/model-choice/`. All test-owned services, advisor processes, compositor
PIDs and private runtime directories were removed after verification.


## Saved hosts and registry provenance

The cycle passed 295 frontend unit tests in 16 files, TypeScript/lint/format checks,
production builds, and 29 targeted Java tests (`DirectoryPublicationTest` and
`DirectoryClientTest`) using Java 26. Java packaging also succeeded with tests
skipped. This is not a fresh full-backend-suite claim.

The final directory/publication browser suite passed 23 scenarios. Checks cover
save/reload, missing listings, current-address-only navigation, changed-model
acknowledgement, search, expiry after resume, rejected registry provenance, changed
configuration, rejected writes, corrupted records left intact, post-write read
failure, explicit recovery, cross-tab changes, delayed storage events and Undo.
Responsive cases exercise 320/768/1024/1440px and keyboard navigation. A final
focused pass of six scenarios passed after the storage empty-state copy adjustment,
including named Undo and screenshots with animations disabled. Four responsive
cases also passed with a DOM check that the unfocused skip link stays off-screen;
resetting scroll before full-page capture avoids a Chromium screenshot artifact.

One browser scenario uses the actual disposable Node registry, signed publication
and withdrawal, built standalone directory, and Java owner proxy. It verifies the
proxy's own source envelope and independent saves in the workspace and standalone
browser origins. Other host/listing cases use intercepted fixtures. Ollama is not
running in this setup: no real model download, GPU inference, public tunnel or
production registry was exercised.

Claude Opus 5 High supplied advice and final read-only review (both successful,
nonempty `claude-opus-5` results). Review fixes tolerate a concurrently removed
storage key, distinguish successful writes from failed rereads, handle unsupported
origins without throwing from storage events, label the most recent Undo target,
and place retry beside blocked model review. The saved-view count was already
independent of directory availability. Unicode label isolation limits effects on
surrounding UI; it does not establish identity or prevent deceptive names.

The review's possible null-observation and unconfigured-origin exceptions were
checked against the wider sources: `InternetSharing` initializes its observation
and only notifies non-null events; `DirectoryClient.exchange` rejects an
unconfigured client before provenance can dereference its origin. Backend origin
validation already rejects `localhost`, IPv6 HTTP and non-root URLs. Concurrent
owner directory reads remain deliberately bounded to one, so another tab can see
a failed check and retry; that is not proof the registry or host is offline.

Screenshots, test/build logs, reviewer output and private-display evidence are
retained under `test-results/saved-hosts/`. The verified Sway 1.12/pixman compositor
runs with private sockets and devices; its PID and runtime were confirmed absent
after testing. Test-owned gateway, web and registry services are stopped at the end
of the cycle. No remote push or deployment is part of this change.


## Guest recovery for empty replies

Two new browser regressions first failed against the previous packaged guest
bundle: local HTTP and internet WebSocket fixtures both returned whitespace-only
terminal answers, but the UI claimed completion and left an empty composer.
After the fix, the full guest suite passed 34 scenarios, including three new
empty-answer cases. They verify restored questions, preservation of independently
typed drafts, explicit Copy question, no redundant access check or automatic
retry, and exactly one retried question alongside earlier completed context.
The existing partial-error test now checks copying the original question without
overwriting the new draft; Stop checks keyboard focus returns to the composer.

All 295 frontend unit tests, TypeScript/lint/format checks and production builds
passed. The guest bundle was packaged into Java 26 with backend tests skipped;
this frontend cycle does not claim a new Java test run. The package command was
initially invoked from the repository root, where no Maven wrapper exists, and
succeeded after using the backend directory.

The built guest assets were served by the actual isolated Java guest listener.
A synthetic Ollama fixture supplied the installed-model metadata needed to enable
that listener. Browser interception supplies guest session/chat responses, including
WebSocket responses: no real model, GPU work or public Cloudflare connection was
used. Tests run on the proved private Sway 1.12/pixman display. Visually inspected
mobile and desktop screenshots, logs and isolation records are retained under
`test-results/guest-recovery/`. Conversation and key storage remain tab-memory-only.

Claude Opus 5 High returned a successful bounded guest audit. The confirmed focus
finding was fixed: expiry revealing the key form must not autofocus it while the
guest types a draft. The expiry regression verifies continued typing stays in the
composer and the password field remains empty. Initial local key entry and explicit
Use another key still receive focus. Device-clock expiry and connected-request
cancellation remain separate follow-up work, not claims established by this fix.
The advisor's relative-deadline suggestion does not eliminate forward-clock-jump
expiry: taking the maximum elapsed delta prevents extension, but can shorten time.
Server-relative session deadlines need their own protocol design and verification.

The final combined guest and access-request suite passed 44 browser scenarios
after the focus correction, including public onboarding at 320/768/1024/1440px.
The expiry screen was visually inspected with an empty password field and the
continued draft intact. All test-owned gateway, web, synthetic Ollama and advisor
processes were stopped; private service and display runtimes were removed.


## Managing requested guest access after connecting

The request controller now survives the chat session reset. The initial combined
browser run passed 50 scenarios, including cancellation during a stream, uncertain
cancellation retained across Disconnect, Disconnect while a cancellation response
is pending, a missing request record, unrelated-key isolation, and a failed
revocation outcome. Responsive cases exercise the Manage access request disclosure
at 320px and 1440px; existing onboarding checks cover 768px and 1024px as well.

The controller suite now checks completion of submit/cancel while hidden and the
unchanged ten-second mutation deadline. The previous hidden-submit test expected
abortion and hung after the intentional policy change; it was replaced with a
successful bounded completion assertion, plus a separate stalled-cancel test.
No hidden mutation automatically retries. The existing approval test now also
checks request-key association without exposing its secret to observable state.

Visually inspected screenshots are retained under `test-results/guest-cancel/`.
The missing-record error was made specific to cancellation instead of suggesting
reconnect with a paused key. Failed revocation retains uncertainty after Disconnect
and requires the discard warning before forgetting that record. Pasted keys are
trimmed consistently for connection and request-key matching, so whitespace cannot
misclassify the same request key as unrelated.

The test setup serves the actual built guest bundle from a disposable Java gateway;
a synthetic Ollama process supplies only the installed-model metadata required to
enable its guest listener. Public-origin request responses and chat WebSockets are
intercepted fixtures. No actual internet tunnel, model inference or GPU work is
claimed, and Java packaging uses skipped backend tests. The shorter host request
record lifetime still limits guest cancellation; durable guest self-revocation
after that record expires remains unimplemented.

Claude Opus 5 High supplied initial advice and a successful integrated review. The
review's confirmed stale-boolean finding was fixed by associating chat with both
request ID and grant ID. A replacement request's rejection cannot pause an earlier
key, and its approval must still offer its own Connect action. Review also led to
conditional wording for unapproved requests, the request-credential Cloudflare
disclosure in compact mode, a visible live status outside collapsed details, and
a guarded reconnect callback. Key matching catches invariant errors rather than
throwing during render. The reviewer also read the backend inbox outside its named
scope; primary inspection confirmed the referenced expiry/revocation semantics.

The final run passed 298 frontend tests in 16 files, type/lint/format checks, all
production bundles, Java packaging with tests skipped, and 51 isolated browser
scenarios. The final checks include same-key paste with surrounding whitespace,
paused-key blocking after Disconnect, replacement-request identity, and the failed
revocation discard warning. Mobile/desktop cancellation, missing-record and failed
revocation states were visually inspected. All test-owned services, both advisor
processes, the exact compositor PID and private runtime directories were removed
after verification. No remote push or deployment was performed.


## Guest device clock independence — 10 September 2026

The page now treats host session authentication and stream outcomes as authoritative.
A displayed expiry instant cannot reject a healthy session or abort an answer based
on the guest device date. The existing protocol is unchanged; no lifetime countdown
or automatic resume/recheck is introduced. An idle page learns expiry on its next
manual send or reconnect. The existing host stream timer still determines active
expiry; this cycle does not redesign host-clock corrections or host suspend behavior.

Validation passed 301 frontend tests in 17 files, type/lint/format checks, all
production bundles and Java packaging. Forty backend tests passed across
SharingLifecycleTest, SharingHttpTest and GuestSocketTest, including expiry closing
an actual upstream connection and rejecting further chat admission. This is targeted
backend coverage, not a full backend-suite run.

All 54 guest and access-request browser scenarios passed on the proved-private
Sway/pixman display. New coverage includes guest clocks 48 hours fast and slow,
forward/backward changes during a stream with timer advancement, preserved draft
focus on a host terminal error, host 401 on reconnect and monotonic retry waits.
The changed connected and expired-access states were visually inspected. Evidence
is retained under `test-results/guest-clock/`.

The Java gateway served the built guest bundle with disposable access storage and
synthetic Ollama metadata. Guest API and WebSocket responses were intercepted
fixtures. No real model download, GPU inference or public Cloudflare tunnel was
used. Rate-limit courtesy waits are capped at five monotonic minutes; HTTP-date
headers without a valid host Date do not impose a guessed device-clock wait.
Browser suspend can pause monotonic waits, while host rate limits remain enforced.

Claude Opus 5 High supplied initial advice and a successful final review. The
review inspected supporting backend tests and transport code beyond its named
scope; its enforcement claims were checked against local code and the targeted
backend run. Review led to status wording explicitly describing the last access
check, clearing completed retry timers, deterministic clock advancement in the
cooldown browser test, and unit checks that HTTP-date waits never read Date.now
and numeric waits ignore an invalid Date header. Host terminal errors remain
intentionally generic until a manual access check; no provider text is echoed.
HTTP-date retry behavior has unit coverage; browser scenarios use the numeric
header emitted by the gateway. Request-inbox timer policies are unchanged.

All owned advisor, service and display processes and private runtime directories
were removed after validation. Screenshots include desktop and 320px layouts.
No remote push or deployment was performed.


## Host model handoff and paused key status — 10 September 2026

Client access now derives model intent from the current URL or the model last
reported by the gateway. The model picker updates the URL without adding history
entries or resetting scroll. A mobile test preserves focus and a nonzero scroll
position across the selection after animation frames settle. An unconfigured gateway requires explicit selection; stopping a configured
model preserves that model and the host name for a restart in the same gateway run.
Missing or inadmissible selections stay visible with recovery guidance. Both form
submission and the button enforce the same readiness condition. The gateway's
existing model/name retention across Stop was inspected in SharingService; no
backend contract or authorization code changed.

Claude Opus 5 High inspected the named host journey files and supplied three
findings: model selection drift and missing recovery, misleading key validity
badges, and test evidence not crossing into Client access. This cycle resolves the
first two. The per-tab Playground test indicator remains separate, and unsaved
host-name edits remain page-local. No claim of hardware fit or successful inference
is added when starting client access. Active key permission is not a reachability
or capacity guarantee; paused and unknown states explain the current limitation.

Validation passed 301 frontend tests, type/lint/format checks and production bundle
builds. The final isolated Sway/pixman browser run passed all 42 scenarios across
sharing, downloads and setup journeys. The single real owner/guest integration
scenario was skipped because the integration flag and disposable Java gateway were
not enabled. The initial run also skipped the separate guest-dependent request
suite; that suite is not counted in this cycle's passing coverage. No backend tests
or Java packaging were performed for this frontend-only change.

New browser coverage checks restart of a non-default model with its existing host
name, explicit model B handoff while A is serving, paused keys that recover when
their model returns, required first selection and matching URL, preserved typed
name during picker navigation, missing-model recovery without substitution,
empty/failed library checks, and interrupted versus unconfirmed internet key status.
The existing internet start scenario now explicitly selects a model before Start.

The actual production owner bundle ran on a disposable loopback Node server; model,
sharing, download and directory responses were fixtures. No real model download,
GPU work, public tunnel or external registry was used. Desktop mismatch and missing
model states and the 320px paused-key state were visually inspected. Evidence is
retained under `test-results/host-handoff/`. All owned advisor, web-server and private
display processes and runtime directories were removed. No remote push or deployment
was performed.


## Sharing draft and Playground evidence — 10 September 2026

A dedicated owner-tab draft provider retains only the edited host name across
workspace routes. Null follows the latest server name; an explicit empty string
remains an edit. Discard clears the draft and returns focus to the name field (or
the serving section when the form is absent). Successful Start acknowledges only
a matching returned model/name and only the unchanged submitted draft. Polls and
lost/rejected mutation responses cannot silently discard it. No browser storage
or additional API is introduced; reload clears the unsaved draft.

The Client access start form and Playground share a derived completed/nonempty
answer predicate. Evidence is scoped to the model name and retained conversation;
model-file digests are not tracked. Model changes select separate histories, and
Clear/reload remove evidence. Starting remains available without a test response,
and the UI disclaims current availability and memory-fit guarantees.

Claude Opus 5 High advised owner-tab state and a derived selector. The implementation
uses a separate draft context rather than adding host settings to the conversation
store. Its suggested unconditional draft clearing on any running status was rejected:
a lost response or another window can report a different running name. A browser
scenario preserves the intended draft through exactly that case and allows explicit
discard after Stop. A matching successful Start still clears the draft normally.

Validation passed 301 frontend tests, type/lint/format checks and all production
frontend bundles. The isolated browser suite passed 53 scenarios across sharing,
owner memory/recovery and model downloads, with the real owner/guest integration
scenario intentionally skipped. An additional focused rejected-Start navigation
and manual-retry scenario passed, for 54 distinct browser checks. New coverage
includes the test-and-return name draft, model-specific evidence, cleared history,
empty/failed answers, empty drafts, reset focus, no browser storage, reload, matching
save acknowledgement, server defaults after save, and uncertain/rejected saves.

Desktop tested-model and 320px draft/reset states were visually inspected. Screenshots,
logs, the advisor result and isolation/cleanup evidence are retained under
`test-results/sharing-draft/`. The production owner bundle ran on a disposable Node
loopback server with intercepted API responses. No real download, GPU inference,
public tunnel, Java integration run or Java packaging was performed in this frontend
cycle. All owned advisor, server and private display processes and runtime directories
were removed. No remote push or deployment was performed.
