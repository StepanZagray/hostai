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

## Interrupted conversation history

A browser regression reproduced an unfinished answer being included in the next
request. With Opus 5 High advice, display turns now carry lifecycle state and
produce a separate wire history: all user messages for the selected model remain,
but only completed, nonblank assistant responses are reused. Interrupted and empty
responses stay visible with an exclusion label. This also prevents blank completed
answers from violating the backend's nonblank-message validation on the next send.

Turns retain their model identity. The chosen model is pinned on the first send;
if discovery loses it, generation pauses with an unavailable selection instead of
silently using a different model or relabeling previous answers. Explicit model
switch and Clear reset history. A synchronous guard prevents duplicate admission.

Validation: 54 unit tests, type checking/lint/formatting, production build, and 16
distinct isolated UI/Electron/integration scenarios across the full and focused
runs. The Java-backed cancellation scenario verifies the next request retains
completed context and user prompts but excludes cancelled output. Other checks
cover empty answers, HTTP failure before content, truncation, Stop before headers,
duplicate submission, model disappearance, switch, and Clear. Screenshots of
interrupted, cancelled, and unavailable-model conversations were inspected.

The focused review was checked against the stream parser: it already stops at
`done:true` and rejects premature EOF, contrary to two review assumptions. The
review's concern about consecutive user messages was checked by running the
Java integration scenario. Its Ollama endpoint remains a test stub; no real model
compatibility or inference-quality claim follows from those tests.

## Conversation request limits

A regression reproduced 32 completed exchanges producing a rejected 65-message
request. With Opus 5 High advice, request preparation now retains a contiguous
suffix of whole turns within all four gateway limits: 64 messages, 16,384 UTF-16
units per message, 65,536 combined units, and 262,144 serialized UTF-8 bytes.
An oversized historical answer drops its turn and all older turns. Incomplete
answers still contribute only their user prompt. The new prompt is never
shortened, and the display transcript is not mutated.

The composer discloses omissions before Send, explicitly saying when only the
new message fits. The request uses that exact prepared body; its omission count
stays attached to the sent user message after completion. These are transport
and validation limits, not the model's token window or a quality guarantee.

Validation: 62 unit tests, type checking/lint/formatting, production build, and
17 distinct isolated browser/Electron scenarios passed across the full and focused
runs. Tests cover exact boundaries, JSON escaping, Unicode, contiguous whole-turn
removal, and preservation of
incomplete-turn behavior. Browser checks verify both complete history omission
and retention of recent turns, the actual request body, disclosure before Send,
persistent annotations, mobile wrapping, and Clear. Desktop and mobile evidence
was visually inspected in `test-results/context-limit-*.png`. The Java integration
scenario was skipped this cycle; Java and proxy code were unchanged, and no real
model was run.

The Opus review confirmed the fitting algorithm and exact boundary arithmetic.
It also identified the textarea's old 16,000-character cutoff, which silently
shortened pasted text before validation. That cutoff is removed: oversized new
messages remain editable, show an error, and cannot be sent until shortened.
A focused browser check verifies full pasted-text preservation, blocked Enter,
error recovery, and a successful next send. Request assertions in the new
context browser scenario run outside route handlers so failures report directly.

## Next candidates to investigate

- Discovery currently accepts cloud-model names that chat validation rejects.
  The review raised this and `OllamaGateway.models()` confirms it; pre-send model
  compatibility feedback remains unimplemented.
- The context-limit mobile screenshot exposes a clipped page description at
  320px. Inspect heading sizing and long-conversation scroll behavior next;
  neither is changed by the context-limit work.
