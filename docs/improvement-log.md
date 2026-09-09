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

## Model admission feedback

Discovery returned model names that chat refused, while the library labeled them
local and enabled generation. A real HTTP regression confirmed missing admission
feedback. Opus 5 High advised sharing one backend policy; the first advisory
process exited without an answer, and a smaller retry completed successfully.
`ModelAdmission` now drives both validation and the discovery DTO's explicit
nullable `chatUnavailableReason`.

Unavailable models remain visible with a reason and no chat link. The playground
chooses the first allowed model by default, blocks unsupported explicit selections,
and retains the chosen conversation when refresh changes admission. Overview
readiness and setup completion use the same discovery metadata. Missing metadata
is unknown, with an update/restart message, rather than permission to generate.
These checks cover known gateway restrictions, not model capabilities or memory.

Validation: 62 web unit tests, 24 Java tests, type checking/lint/formatting,
production build, and 24 distinct isolated browser/Electron/integration scenarios
passed across full and focused runs. A prior label assertion was updated from
installed to discovered. The real Java integration scenario includes a cloud
fixture entry, verifies its reason and the allowed default, then checks streaming
and cancellation through Java. No model was downloaded or run. The new library
and blocked playground states were visually inspected, including mobile.

The final Opus review identified two mixed-state problems, now covered by browser
checks: runtime setup stays available when connectivity and model admission both
fail, and API examples require an allowed selected model. Its proposed narrowing
of the existing `-cloud` restriction was not adopted; this cycle preserves the
existing admission policy while making its decisions visible.

The suspected mobile heading clipping was not reproduced by settled geometry
checks across all five routes at 320px. The check waits for fonts and host state;
viewport and full-page captures were inspected. No heading CSS was changed.

## Reading streamed conversations

Two isolated browser regressions reproduced each chunk pulling the reader back
to the bottom (523px in the initial check) and moving the surrounding mobile page
(62px). With Opus 5 High advice, the conversation now scrolls its own container,
tracks following intent, and offers an accessible Jump to latest button. A new
prompt resumes following; reading earlier text pauses it. Clear, model switches,
and new submissions use a fresh native scroll container so an unfinished browser
keyboard animation cannot carry into the next answer. Jump returns focus to the
pane without moving the page.

The initial advice assumed resize does not fire scroll events. A failing Chromium
resize test disproved that, so geometry changes preserve follow intent. The review
also prompted explicit upward wheel, keyboard, and touch handling: genuine input
wins over simultaneous reflow. A rapid-stream regression found near-bottom
keyboard animation could undo a pause; resuming from that state now requires
movement toward the bottom. The immediate model-switch and rapid keyboard cases
both passed three repeated runs after their fixes.

Validation: 62 web unit tests, type checking/lint/formatting, production build,
and 30 distinct isolated UI/Electron scenarios passed across full and focused
runs. Tests cover native wheel/keyboard input, follow-up sends, Clear/model reset,
resize at 320/768/1440px, page-position preservation, and deterministic concurrent
input/reflow. Desktop and mobile states were visually inspected. Java integration
was skipped because gateway/proxy behavior did not change; no actual model ran.
Touch coverage exercises event handling in Chromium, not a native mobile browser.

## Readable answers and copying

With Opus 5 High advice and review, assistant answers now render Markdown and GFM
lists/tables with accessible, horizontally scrollable code blocks. Original
response text remains the source for whole-response copying and outgoing context.
Unfinished fences render naturally; failed/cancelled answers retain the adjacent
context exclusion notice and expose Copy partial response. Empty code cannot be
copied. Copy status belongs to its source text and ignores stale async results.

Images become alt-text placeholders without a request. Raw HTML is escaped, and
only credential-free HTTPS links activate. Browser and desktop share this URL
policy; desktop now supports answer references beyond the previous three docs
hosts. Invalid navigation and unavailable system browsers cannot throw out of the
handler. External browser handoff itself was not exercised.

The review caught duplicated inactive autolinks and empty-code copying. Its claim
that raw HTML vanished was contradicted by the installed renderer's raw-to-text
transform and a regression test; no additional HTML plugin was added. Plain-text
soft line breaks stay visible. Completed answer parsing is memoized, but active
answers still parse per chunk; no large-output performance claim is made.

Isolated desktop verification exposed the existing blanket clipboard-write deny.
Both permission handlers now allow only sanitized writes from the trusted main
frame and local origin. A native key event supplies the private Wayland clipboard
serial, and wl-paste checks the actual copied command. Reads remain denied. No
live desktop or clipboard was accessed. New runner prerequisites are wtype and
wl-clipboard.

Pinned dependencies are react-markdown 10.1.0 and remark-gfm 4.0.1. The test glob
now includes TSX so renderer unit tests actually run; Panda excludes those tests.
The existing Vite-plus alias still causes pnpm's peer checker to report Vite
version mismatches in Vitest/mocker; this predates the Markdown dependencies.

Validation: 80 web unit tests, type checking/lint/formatting, production build,
and 34 isolated UI/Electron scenarios passed. Desktop, formatted answers, and
mobile/code overflow states were visually inspected. The Java integration case
was skipped because gateway behavior did not change. No actual model ran;
macOS clipboard and external browser launch remain unverified.

## Scheduling streamed answer formatting

A production-app fixture measured one 16,000-character answer across 1,000
worker-paced chunks. Without artificial slowdown, dense Markdown produced a
33ms p95 frame gap versus 16ms for prose; neither had >50ms main-thread tasks.
Thus a zero long-task count alone would have missed the scheduling difference.
Under Chromium's artificial 4× CPU slowdown, Markdown produced 117ms p95 frame
gaps and a 151ms maximum in the initial run. Prose still uses the same parser;
this comparison isolates content complexity, not all parser overhead.

Following Opus 5 High advice, `Answer` now defers only the displayed string and
passes it to a memoized formatting component. The memo boundary prevents urgent
renders with the old deferred text from parsing that text again. Raw accumulated
state, terminal handling and response copying stay unchanged. `aria-busy` marks
the formatting catch-up. Completed turns retain memoization.

The first deferred run reduced the dense fixture's p95 frame gap from 117ms to
67ms and its maximum from 151ms to 109ms at 4× slowdown. This is a partial,
exploratory result on a software-rendered test display; individual synchronous
parses can still block, and the displayed answer can lag received text. The
change does not claim a model-speed or real-device responsiveness benchmark.

Two follow-up runs waited for `aria-busy` to clear before stopping measurement:
dense Markdown p95 callback gaps were 66ms and 57ms, with maxima of 107ms and
120ms. They recorded 50 and 49 >50ms tasks versus 70 in the initial baseline.
Worker delivery spanned 9,990ms in both; both copied all 16,000 source characters.
These few runs support the direction, not a precise cross-device speedup.

The final Opus review identified the terminal-DOM measurement boundary and a
multi-chunk coverage gap. Both are now explicit checks. Validation: 80 unit tests,
type checking/lint/formatting, production build, 35 distinct browser/Electron
scenarios across full/focused runs, and both diagnostic scenarios repeated twice.
Completed deferred output was visually inspected. The unchanged Java integration
was skipped, and no actual model ran.

## Auditing the host and client journeys

After finishing the rendering cycle, the user's full workflow was traced with
Opus 5 High advice. [The journey audit](user-journeys.md) separates implemented UX
problems from absent download management, authentication/sharing, remote access
and host-directory services, with concrete host/client states and recovery paths.
The global 15-second visibility-aware poll already exists; the advice to add
polling was not applied. Inbound loopback binds were checked directly.

The first setup regression reproduced the missing handoff into model selection.
The Connection page's old instructions also combined a standalone gateway with a
launcher that requires its port to be free. The revised guide appears before
diagnostics, acknowledges running services, leads a ready library to chat, and
uses the current workspace origin for browser access. Unavailable discovered
models lead to their reasons before a redundant download suggestion. Sharing
copy explicitly names the missing remote capabilities.

Validation: type checking/lint/formatting and production build passed, along with
seven distinct targeted setup, navigation, responsive-heading and Electron
scenarios across focused runs. Ready, empty and unavailable-model setup states
were visually inspected. One fixture initially omitted `connected: true` and
correctly triggered discovery failure; it was corrected without weakening the
application check. The full remote workflow remains unimplemented, no model was
downloaded, and nothing was exposed to the internet.

## Completing local model downloads

Opus 5 High advised the download lifecycle. Fable High was attempted twice but
rejected both calls with the account's resource-limit response; GPT-6 Astra XHigh
implemented the bounded Java scope in an isolated worktree instead. Its socket
sandbox prevented network tests, so the primary agent reviewed and integrated
its changes and ran the full HTTP suite with isolated local runtime fixtures.
No delegated model was credited for execution its account or sandbox rejected.

The Models page now accepts explicit tagged library names and manages one download
at a time. Jobs belong to the gateway, survive browser navigation, expose bounded
current-layer progress and explicit cancel/retry, and retain at most 20 records.
An uncertain start retains its request ID, with an explicit way to dismiss the
entry; cancellation is never implied by dismissal. Completion refreshes model
discovery and offers a deliberate handoff to chat. Setup links to this flow.
Unknown counts stay indeterminate, malformed/status failures remain actionable,
and stale GET responses cannot overwrite a completed cancellation.

The first independent backend run found an overall-deadline connection leak:
`takeUntilOther` with an error-producing timer forwarded failure without cancelling
its main source in the installed Reactor version. A real socket regression also
reproduced the same existing chat bug. Both paths now emit a deadline value to
cancel the source, then translate completion into the explicit timeout error.
The before-fix tests observed a live upstream socket after failure; the corrected
suite verifies its closure. Pull idle timeout is independently five minutes to
allow silent integrity verification; total pull time remains bounded at two hours.

The new management endpoints require JSON and exact browser origin checks. The
Java boundary also rejects non-loopback Host names, including a matching rebound
Origin/Host pair; the production web server already had this Host restriction.
These checks are not authentication. The UI/API remain unauthenticated and bound
to loopback; no tunnel, sharing, directory, remote client or access grant exists.

Opus's first final review could read only frontend files because the isolated
backend worktree was outside its permitted scope. It correctly flagged raw JSON
parse errors and a missing uncertain-request dismissal; those were addressed.
Its insecure-LAN UUID warning does not apply to the supported loopback deployment,
and its web Host warning was checked against the existing server guard. Malformed
job lists still fail closed, because silently skipping an active job would enable
misleading controls. Backend review was repeated after files were integrated and confirmed the deadline
fix and subscription ownership. Its Host-header finding reflected a read made
before the concurrently added guard/test; the final 71-test suite covers that case.
Its statement that cache/history caveats were unsurfaced was checked against the
existing cancellation text and history footer. Suggestions about future HTTP
methods and fatal JVM errors were not treated as current defects. Cross-record
counter inconsistency remains an explicit protocol failure; supported layer changes
carry their digest, and unknown counts are already represented without a percentage.

Verification evidence is recorded in verification.md. No model was downloaded or
run, and no public endpoint was opened; integration uses only simulated Ollama
responses. Download history/idempotency are intentionally not durable across
restart or eviction, and cancellation cannot promise deletion of cached layers or
termination of work another Ollama client requested.

## Next candidates to investigate

Continue the full host/client destination in [user-journeys.md](user-journeys.md):
requirements-aware model discovery, reliable conversation retry/preservation,
then authenticated model serving with revocable invites and a distinct client
connection/chat surface. Choose and verify a transport before implementing internet
sharing, and add searchable public hosts on top of working private connections.
The local download improvements do not substitute for those missing services.
