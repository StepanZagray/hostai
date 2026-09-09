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

`pnpm build && pnpm test:http` launches the built Node/Start server and an HTTP backend stub on ephemeral loopback ports. It verifies byte-preserving forwarding and real 413/504 responses for oversized or stalled uploads, then checks that the server still handles another request. This catches incoming-socket teardown bugs that mocked Fetch streams cannot reproduce. Both processes and all sockets are closed afterward. CI runs this suite after building; it needs no display or Java service.

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
- No internet sharing/authentication or persistent database is present.
- Production CSP allows inline scripts for Start's hydration bootstrap. The Electron renderer has no Node bridge and denies permission requests.
