# Autonomous improvement log

## Streaming reliability

Advice and focused reviews used Claude Opus 5 at high effort through Claude Code.
Recommendations were checked against the implementation and reproducing tests.

- The browser stops at the terminal NDJSON record, includes its content, releases
  the stream, and presents a consistent error for malformed records.
- The proxy enforces the backend's byte limit while reading, preserves overload
  headers, handles upload cancellation/timeouts, and lets the backend's default
  generation deadline expire first.
- Real socket checks caught a Node incoming-stream cancellation crash and a
  continuing-upload write race. Early responses now precede bounded draining and
  connection closure. These tests run in CI against the built server.
- A deterministic test reproduced completion misclassified as cancellation when
  the consumer stopped on the final record. Accounting now commits completion and
  tokens before exposing that record. Cancellation before it remains terminal;
  a later signal does not overwrite the registry's first terminal state.
- The idle-timeout message describes stalled stream progress without attributing
  every timeout to Ollama. Backpressure still bounds resource retention.
- UI cleanup now accounts for orphaned workers in the runner's exact process
  groups, with Bubblewrap parent-death protection. A separate orphan-worker
  harness verified detection and cleanup; the isolated UI suite also passed.

Validation: type checking, lint, formatting, production build, 35 stream/proxy
tests, 22 Java tests, five real-socket HTTP tests, and seven isolated UI/Electron
scenarios. Development-server oversized uploads were also checked. Playground
completion/error screenshots are retained in ignored `test-results/`.

Limits: HTTP fixtures do not run models or measure inference quality/performance.
Authentication, tunnels, persistent history, installers, and bundled Java remain
unimplemented. The UI suite still requires the documented Linux isolation tools
and is separate from CI. The proxy deadline is fixed; custom Java generation
timeouts must remain below it.

## Independent refresh failures

Opus 5 High advised on endpoint independence and freshness. Refresh now keeps
successful status/model/history results independently. Failed fields are cleared
and labeled unavailable; cached values are not presented as current. In
particular, a history failure leaves healthy chat usable, while failed status or
model discovery cannot imply generation readiness. An available, empty model
library remains distinct from failed discovery.

A shared accessible notice identifies each failure and offers keyboard-accessible
retry on every page. Activity and model views show unavailable states instead of
claiming empty results, and unknown model counts use an unavailable label. Abort
and controller-identity guards discard superseded refreshes.

The focused Opus review also caught two display assumptions: a missing status
check now reads unavailable, and an empty library follows successful discovery
even when the separate status check fails. One review attempt exited without an
answer; the retry completed. The backend contract was checked before accepting
the review's claims about successful-but-unavailable responses.

Validation: 47 unit tests, type checking/lint/formatting, production build, and
ten isolated browser/Electron scenarios. Browser checks cover mixed endpoint
outcomes, chat during a history failure, recovery, keyboard retry, and responsive
layouts, and unknown counts during loading. The Java integration scenario was
skipped in this cycle; proxy and Java code were not changed. Screenshots are in ignored `test-results/`.

## Next candidates to investigate

- `playground.tsx` retains partial failed assistant responses in `messages`, which
  is also reused as the next request's history despite the nearby exclusion
  comment. Establish the intended retry/history behavior with regression tests.

This candidate has not been implemented yet.
